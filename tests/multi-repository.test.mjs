import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const fixtureRoot = join(workspace, "characterization", "multi-repo");
const repoA = join(fixtureRoot, "repo-a");
const repoB = join(fixtureRoot, "repo-b");
const configPath = join(fixtureRoot, `.runtime-${process.pid}.json`);

function childEnv() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.CODESCOPE_CONFIG = configPath;
  return env;
}

function body(response) {
  return response?.result?.structuredContent ?? response?.structuredContent ?? response?.result ?? response;
}

function serialized(response) {
  return JSON.stringify(response ?? null);
}

function assertSuccess(response, label) {
  assert.equal(response?.error, undefined, `${label}: ${serialized(response)}`);
  assert.notEqual(response?.result?.isError, true, `${label}: ${serialized(response)}`);
  assert.notEqual(body(response)?.isError, true, `${label}: ${serialized(response)}`);
}

function assertRejected(response, code, label) {
  const envelope = response?.result ?? response;
  const result = envelope?.structuredContent ?? envelope;
  assert.equal(response?.error, undefined, `${label} returned a transport error: ${serialized(response)}`);
  assert.equal(envelope?.isError, true, `${label} was accepted: ${serialized(response)}`);
  assert.equal(result?.error, code, `${label} returned the wrong rejection: ${serialized(response)}`);
}

// Deterministic harness model only: this is an alias/root lock key, not a
// ChatGPT identity or a claim that the bridge exposes a real selection lock.
function modeledSelection(catalog, alias) {
  const entry = catalog.repositories[alias];
  if (!entry) throw new Error(`unknown modeled alias: ${alias}`);
  return { alias, root: resolve(entry.root), lockKey: `local-alias-lock:${alias}` };
}

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.read(chunk));
    child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    child.on("close", (code, signal) => {
      this.exit = { code, signal };
      for (const pending of this.pending.values()) pending.reject(new Error(`bridge exited: ${code ?? signal}`));
      this.pending.clear();
    });
  }

  static async start() {
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: workspace,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new McpClient(child);
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codescope-multi-repository-characterization", version: "0.1.0" },
      });
      assert.equal(initialized.error, undefined, `initialize failed: ${serialized(initialized)}`);
      client.notify("notifications/initialized");
      return client;
    } catch (error) {
      await client.abort();
      throw new Error(`${error.message}; stderr: ${client.stderr.slice(-2000)}`);
    }
  }

  read(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      pending.resolve(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`MCP request timed out: ${method}`));
      }, 8000);
      this.pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  call(name, argumentsValue) {
    return this.request("tools/call", { name, arguments: argumentsValue });
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolvePromise();
      }, 2500);
      this.child.once("close", () => { clearTimeout(timer); resolvePromise(); });
    });
    assert.deepEqual(this.exit, { code: 0, signal: null }, `bridge did not close cleanly: ${this.stderr.slice(-2000)}`);
  }

  async abort() {
    if (this.child.exitCode !== null) return;
    this.child.kill();
    await new Promise((resolvePromise) => this.child.once("close", resolvePromise));
  }
}

let client;

before(async () => {
  const catalog = {
    repositories: {
      "repo-a": { root: repoA, read_only: true },
      "repo-b": { root: repoB, read_only: true },
    },
    default_repository: "repo-a",
    limits: { max_response_bytes: 65536, max_file_bytes: 524288, max_lines: 100, timeout_ms: 5000 },
  };
  assert.notEqual(await realpath(repoA), await realpath(repoB), "mock repository roots must be distinct");
  await writeFile(configPath, JSON.stringify(catalog, null, 2), "utf8");
  client = await McpClient.start();
});

after(async () => {
  await client?.close();
  await rm(configPath, { force: true });
});

test("two repository aliases isolate reads and reject unknown or escaping selections", async () => {
  const catalog = JSON.parse(await readFile(configPath, "utf8"));
  const selectionA = modeledSelection(catalog, "repo-a");
  const selectionB = modeledSelection(catalog, "repo-b");
  assert.deepEqual(selectionA, modeledSelection(catalog, "repo-a"), "modeled alias selection is not deterministic");
  assert.notEqual(selectionA.root, selectionB.root, "modeled aliases share a root");
  assert.notEqual(selectionA.lockKey, selectionB.lockKey, "modeled aliases share a lock key");

  const listed = await client.request("tools/list");
  assertSuccess(listed, "tools/list");
  assert.ok((body(listed).tools || []).some((tool) => tool.name === "fs_read_text"), "fs_read_text is not published");

  const readA = await client.call("fs_read_text", { repository: "repo-a", path: "only-a.txt", start_line: 1, end_line: 10, max_bytes: 256 });
  const readB = await client.call("fs_read_text", { repository: "repo-b", path: "only-b.txt", start_line: 1, end_line: 10, max_bytes: 256 });
  assertSuccess(readA, "read repo-a");
  assertSuccess(readB, "read repo-b");
  assert.equal(body(readA).repository, "repo-a");
  assert.equal(body(readB).repository, "repo-b");
  assert.match(body(readA).text, /A_ONLY_20260911/u);
  assert.match(body(readB).text, /B_ONLY_20260911/u);
  assert.doesNotMatch(serialized(readA), /B_ONLY_20260911/u, "repo-a read crossed into repo-b");
  assert.doesNotMatch(serialized(readB), /A_ONLY_20260911/u, "repo-b read crossed into repo-a");

  const unknownAlias = await client.call("fs_read_text", { repository: "repo-unknown", path: "only-a.txt", start_line: 1, end_line: 1, max_bytes: 128 });
  assertRejected(unknownAlias, "repository_denied", "unknown repository alias");

  const escapePath = relative(repoA, join(repoB, "only-b.txt")).replaceAll("\\", "/");
  const escapedRepository = await client.call("fs_read_text", { repository: "repo-a", path: escapePath, start_line: 1, end_line: 1, max_bytes: 128 });
  assertRejected(escapedRepository, "path_denied", "repository escape");
  assert.doesNotMatch(serialized(escapedRepository), /B_ONLY_20260911/u, "repository escape leaked repo-b content");
});
