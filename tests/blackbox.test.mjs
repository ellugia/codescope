import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, link, writeFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { test, beforeEach, after } from "node:test";

// Black-box contract runner. The bridge command is supplied at run time while
// the MCP tool names and argument shapes below are the reviewed contract:
//
//   $env:BRIDGE_COMMAND = '...absolute path to node.exe or bridge executable'
//   $env:BRIDGE_ARGS_JSON = '["...script or args..."]'
//
// The child receives only BRIDGE_* values plus the minimum process variables;
// host credentials are intentionally not inherited.

const workspace = resolve(import.meta.dirname, "..");
const runtimeRoot = resolve(process.env.BRIDGE_FIXTURE_DIR || join(workspace, "tests", ".blackbox-runtime"));
const ownedRuntimePrefix = join(workspace, "tests") + sep;
const configured = Boolean(process.env.BRIDGE_COMMAND);

const contract = {
  aliases: { root: "fixture-root", repo: "fixture-repo" },
  hiddenTools: [
    "write_file", "edit_file", "create_directory", "move_file", "git_commit",
    "git_add", "git_reset", "git_create_branch", "git_checkout", "ctx_execute",
    "fs_write_text", "fs_write_file", "fs_edit", "fs_delete", "fs_move", "fs_read_media",
    "git_branch", "git_show",
  ],
  tools: {
    fsRead: { name: "fs_read_text", args: { repository: "{rootAlias}", path: "{path}", start_line: "{startLine}", end_line: "{endLine}", max_bytes: "{maxBytes}", cursor: "{readCursor}" } },
    fsList: { name: "fs_list", args: { repository: "{rootAlias}", path: "{path}", max_entries: "{maxEntries}", cursor: "{cursor}" } },
    fsFind: { name: "fs_find", args: { repository: "{rootAlias}", path: "{path}", name_contains: "{nameContains}", max_entries: "{maxEntries}", cursor: "{cursor}" } },
    fsContentSearch: { name: "fs_search_content", args: { repository: "{rootAlias}", path: "{path}", query: "{query}", max_matches: "{maxMatches}", cursor: "{cursor}" } },
    gitStatus: { name: "git_status", args: { repository: "{repoAlias}", max_entries: "{maxEntries}", cursor: "{cursor}" } },
    gitDiffStaged: { name: "git_diff_staged", args: { repository: "{repoAlias}", path: "{path}", context_lines: "{contextLines}", max_bytes: "{maxBytes}" } },
    gitDiffUnstaged: { name: "git_diff_unstaged", args: { repository: "{repoAlias}", path: "{path}", context_lines: "{contextLines}", max_bytes: "{maxBytes}" } },
    gitDiffReference: { name: "git_diff", args: { repository: "{repoAlias}", reference_sha: "{revision}", path: "{path}", context_lines: "{contextLines}", max_bytes: "{maxBytes}", cursor: "{diffCursor}" } },
    gitLog: { name: "git_log", args: { repository: "{repoAlias}", revision_sha: "{revision}", path: "{path}", max_count: "{maxCount}", cursor: "{cursor}" } },
    // These are required by the reviewed contract; their absence must fail the
    // allowlist test rather than being treated as an optional capability.
    gitHead: { name: "git_head", args: { repository: "{repoAlias}" } },
    gitRef: { name: "git_ref", args: { repository: "{repoAlias}", revision_sha: "{revision}" } },
  },
};

const hiddenTools = [...new Set(contract.hiddenTools || [])];

let fixture;

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : fallback;
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function ownedPath(path) {
  const full = resolve(path);
  assert.ok(full === runtimeRoot || full.startsWith(ownedRuntimePrefix), `fixture path escapes tests/: ${full}`);
  return full;
}

function replaceTokens(value, vars) {
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, vars)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{([A-Za-z0-9_]+)\}$/u);
  if (exact && exact[1] in vars) return vars[exact[1]];
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
    if (!(key in vars)) return `{${key}}`;
    return String(vars[key]);
  });
}

function toolSpec(key) {
  const spec = contract.tools?.[key];
  if (!spec || typeof spec.name !== "string") return null;
  return spec;
}

function toolCallArgs(key, vars) {
  const spec = toolSpec(key);
  if (!spec) return null;
  return replaceTokens(spec.args || {}, vars);
}

function responseJson(response) {
  return JSON.stringify(response ?? null);
}

function responseText(response) {
  const result = response?.result ?? response;
  const chunks = [];
  const visit = (value) => {
    if (typeof value === "string") chunks.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      if (typeof value.text === "string") chunks.push(value.text);
      if ("content" in value) visit(value.content);
      if ("structuredContent" in value) visit(value.structuredContent);
      if ("data" in value && typeof value.data === "string") chunks.push(value.data);
    }
  };
  visit(result);
  return chunks.join("\n");
}

function redacted(value) {
  let text = typeof value === "string" ? value : responseJson(value);
  for (const secret of fixture?.secrets || []) {
    if (secret) text = text.split(secret).join("<SYNTHETIC_SECRET>");
  }
  return text.length > 2000 ? `${text.slice(0, 2000)}…<truncated>` : text;
}

function hasError(response) {
  const result = response?.result ?? response;
  return Boolean(response?.error || result?.isError || result?.error);
}

function errorCode(response) {
  return response?.error?.code ?? response?.result?.error?.code;
}

function assertRejected(response, message = "expected a rejected call") {
  assert.ok(hasError(response), `${message}; got ${redacted(response)}`);
}

function assertNoSecret(response, message = "response contains a synthetic secret") {
  const body = responseJson(response);
  for (const secret of fixture.secrets) {
    assert.equal(body.includes(secret), false, `${message}: ${redacted(response)}`);
  }
}

function assertNoMarker(path, marker) {
  assert.equal(existsSync(path), false, `external helper marker was created: ${marker}`);
}

function fixturePath(path) {
  return relative(fixture.root, path).split(sep).join("/");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process timeout: ${command}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code ?? signal}: ${stderr.slice(0, 1000)}`));
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

async function git(repo, args, options = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    ...(options.env || {}),
  };
  for (const name of [
    "OPENAI_API_KEY", "CONTROL_PLANE_API_KEY", "OPENAI_ADMIN_KEY", "GITHUB_TOKEN", "GH_TOKEN",
    "GIT_EXTERNAL_DIFF", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
  ]) delete env[name];
  return runProcess("git", ["-C", repo, ...args], { ...options, env });
}

async function createFixture() {
  const root = ownedPath(join(runtimeRoot, "repo with spaces", "référence"));
  const repo = root;
  const outside = ownedPath(join(runtimeRoot, "outside"));
  await mkdir(repo, { recursive: true });
  await mkdir(outside, { recursive: true });

  const secrets = [
    "SYNTHETIC_API_KEY_BRIDGE_20260910_01",
    "SYNTHETIC_HISTORY_TOKEN_BRIDGE_20260910_02",
    "SYNTHETIC_PRIVATE_KEY_BRIDGE_20260910_03",
    "SYNTHETIC_CLIENT_SECRET_BRIDGE_20260910_04",
  ];
  const [apiSecret, historySecret, privateSecret, clientSecret] = secrets;
  const outsideFile = join(outside, "outside-secret.txt");
  const outsideUndetectedSecretFile = join(outside, "outside-client-secret.txt");
  await writeFile(outsideFile, `outside marker\nAPI_KEY=${apiSecret}\n`, "utf8");
  await writeFile(outsideUndetectedSecretFile, `client_secret=${clientSecret}\n`, "utf8");
  await writeFile(join(root, ".env"), `TOKEN=${apiSecret}\n`, "utf8");
  await writeFile(join(root, "credentials.json"), JSON.stringify({ token: apiSecret }), "utf8");
  await writeFile(join(root, "private.pem"), `-----BEGIN PRIVATE KEY-----\n${privateSecret}\n-----END PRIVATE KEY-----\n`, "utf8");
  await writeFile(join(repo, "README.md"), "fixture README\n", "utf8");
  await writeFile(join(repo, "src-main.js"), "export const value = 'initial';\n", "utf8");
  await writeFile(join(repo, "staged.txt"), "staged baseline\n", "utf8");
  await writeFile(join(repo, "unstaged.txt"), "unstaged baseline\n", "utf8");
  await writeFile(join(repo, "history.txt"), `TOKEN=${historySecret}\n`, "utf8");
  await writeFile(join(repo, "app-config.json"), `client_secret=${clientSecret}\n`, "utf8");
  await writeFile(join(repo, ".gitignore"), ".env\ncredentials.json\n", "utf8");
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Bridge Fixture"]);
  await git(repo, ["config", "user.email", "bridge-fixture@example.invalid"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", `TOKEN=${historySecret}`]);

  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const indexPath = (await git(repo, ["rev-parse", "--git-path", "index"])).stdout.trim();
  const absoluteIndex = isAbsolute(indexPath) ? indexPath : join(repo, indexPath);
  return {
    root,
    repo,
    outside,
    outsideFile,
    outsideUndetectedSecretFile,
    head,
    indexPath: absoluteIndex,
    secrets,
    privateSecret,
    apiSecret,
    historySecret,
    clientSecret,
    vars: {
      root,
      repo,
      path: "",
      outside,
      outsideFile,
      rootAlias: contract.aliases?.root || "fixture-root",
      repoAlias: contract.aliases?.repo || "fixture-repo",
      head,
      query: "BRIDGE_CONTENT_CANARY_20260910",
      pattern: "*.txt",
      nameContains: "FILENAME_CANARY_20260910",
      startLine: 1,
      endLine: 100,
      maxBytes: 256,
      maxEntries: 3,
      maxMatches: 3,
      contextLines: 3,
      maxCount: 1,
      cursor: "0",
      readCursor: undefined,
      diffCursor: undefined,
      revision: head,
      outsideRevision: "refs/heads/main",
    },
  };
}

async function resetFixture() {
  ownedPath(runtimeRoot);
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  fixture = await createFixture();
}

function childEnvironment() {
  const env = {};
  const names = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "LANG", "LC_ALL", "NODE_PATH", "CODEX_HOME",
  ];
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("BRIDGE_")) env[name] = value;
  }
  env.BRIDGE_FIXTURE_ROOT = fixture.root;
  env.BRIDGE_FIXTURE_REPO = fixture.repo;
  const extra = parseJsonEnv("BRIDGE_CHILD_ENV_JSON", {});
  Object.assign(env, extra);
  for (const name of ["OPENAI_API_KEY", "CONTROL_PLANE_API_KEY", "OPENAI_ADMIN_KEY", "GITHUB_TOKEN", "GH_TOKEN"]) {
    delete env[name];
  }
  return env;
}

class BridgeClient {
  static async start() {
    if (!configured) throw new Error("BRIDGE_COMMAND is not configured");
    const command = process.env.BRIDGE_COMMAND;
    const args = parseJsonEnv("BRIDGE_ARGS_JSON", []);
    if (!isAbsolute(command) && process.env.BRIDGE_ALLOW_PATH_COMMAND !== "1") {
      throw new Error("BRIDGE_COMMAND must be an absolute path (set BRIDGE_ALLOW_PATH_COMMAND=1 only for a controlled fixture)");
    }
    const child = spawn(command, args, {
      cwd: process.env.BRIDGE_CWD || workspace,
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new BridgeClient(child);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.abort();
      throw new Error(`${error.message}; bridge stderr: ${redacted(client.stderr)}`);
    }
  }

  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = [];
    this.protocolNoise = [];
    this.stderr = "";
    this.forcedKill = false;
    this.closed = false;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16000);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", (code, signal) => {
      this.exit = { code, signal };
      this.rejectAll(new Error(`bridge exited ${code ?? signal}: ${redacted(this.stderr)}`));
    });
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  onStdout(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
      this.child.kill();
      this.rejectAll(new Error("bridge stdout exceeded 4 MiB test ceiling"));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.protocolNoise.push(line.slice(0, 500));
        continue;
      }
      if (message.id !== undefined && message.method) {
        this.serverRequests.push(message);
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported server request in black-box test" } });
        continue;
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(String(message.id));
        if (entry) {
          this.pending.delete(String(message.id));
          entry.resolve(message);
        }
      }
    }
  }

  write(message) {
    if (this.child.stdin.destroyed) throw new Error("bridge stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: process.env.BRIDGE_PROTOCOL_VERSION || "2025-11-25",
      capabilities: {},
      clientInfo: { name: "codescope-security-blackbox", version: "0.1.0" },
    });
    assert.equal(response.error, undefined, `initialize failed: ${redacted(response)}`);
    this.notify("notifications/initialized");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.deepEqual(this.serverRequests, [], `bridge requested forbidden server capabilities: ${redacted(this.serverRequests)}`);
    return response;
  }

  call(name, args = {}, timeoutMs = 8000) {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolvePromise) => {
      if (this.child.exitCode !== null) return resolvePromise();
      const timer = setTimeout(() => {
        this.forcedKill = true;
        this.child.kill();
        resolvePromise();
      }, 2500);
      this.child.once("close", () => { clearTimeout(timer); resolvePromise(); });
    });
    assert.equal(this.forcedKill, false, `bridge did not stop cleanly: ${redacted(this.stderr)}`);
  }

  async abort() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.destroy(); } catch { /* already closed */ }
    if (this.child.exitCode !== null) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => { try { this.child.kill(); } catch { /* already closed */ } resolvePromise(); }, 1000);
      this.child.once("close", () => { clearTimeout(timer); resolvePromise(); });
    });
  }
}

async function withBridge(t, callback) {
  if (!configured) {
    t.skip("BLOCKED: configure BRIDGE_COMMAND and BRIDGE_ARGS_JSON for the real bridge");
    return;
  }
  const client = await BridgeClient.start();
  try {
    await callback(client);
  } finally {
    await client.close();
  }
}

async function callContract(client, key, vars = fixture.vars, timeoutMs = 8000) {
  const spec = toolSpec(key);
  if (!spec) throw new Error(`contract.tools.${key} is missing`);
  return client.call(spec.name, toolCallArgs(key, vars), timeoutMs);
}

function skipIfNoTool(t, key) {
  if (!configured) {
    t.skip("BLOCKED: configure BRIDGE_COMMAND and BRIDGE_ARGS_JSON for the real bridge");
    return true;
  }
  if (toolSpec(key)) return false;
  t.skip(`NOT_RUN: contract.tools.${key} is not published yet`);
  return true;
}

beforeEach(async () => {
  if (!configured) return;
  await resetFixture();
});

after(async () => {
  await rm(runtimeRoot, { recursive: true, force: true });
});

test("bridge command precondition", (t) => {
  if (!configured) {
    t.skip("BLOCKED: BRIDGE_COMMAND is not configured; no security result is asserted");
    return;
  }
  assert.ok(true);
});

test("SEC-01 tools/list is a positive read-only surface", async (t) => {
  await withBridge(t, async (client) => {
    const response = await client.request("tools/list");
    assert.equal(response.error, undefined, `tools/list failed: ${redacted(response)}`);
    const names = (response.result?.tools || []).map((tool) => tool.name);
    assert.ok(names.length > 0, "tools/list returned no tools");
    for (const forbidden of hiddenTools) {
      assert.equal(names.includes(forbidden), false, `forbidden tool advertised: ${forbidden}`);
    }
    const configuredNames = Object.values(contract.tools || {}).map((spec) => spec.name).filter(Boolean);
    for (const name of configuredNames) assert.ok(names.includes(name), `contract tool missing from tools/list: ${name}`);
  });
});

test("SEC-01 direct hidden write and unknown tools are rejected", async (t) => {
  await withBridge(t, async (client) => {
    const target = join(fixture.repo, "must-not-write.txt");
    const before = await sha256(fixture.indexPath);
    for (const name of hiddenTools) {
      const response = await client.call(name, { path: target, content: "MUTATION_MUST_NOT_HAPPEN" });
      assertRejected(response, `hidden tool ${name} was accepted`);
    }
    const unknown = await client.call("bridge_unknown_tool_20260910", {});
    assertRejected(unknown, "unknown tool was accepted");
    assert.equal(existsSync(target), false, "hidden write created a file");
    assert.equal(await sha256(fixture.indexPath), before, "hidden write changed the Git index");
  });
});

test("SEC-01 extra arguments are rejected instead of silently stripped", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  await withBridge(t, async (client) => {
    const spec = toolSpec("fsRead");
    const args = toolCallArgs("fsRead", fixture.vars);
    const response = await client.call(spec.name, { ...args, extra_untrusted_argument: "must-reject" });
    assertRejected(response, "unknown extra argument was accepted");
  });
});

test("SEC-04 resources, prompts, roots, sampling and elicitation stay closed", async (t) => {
  await withBridge(t, async (client) => {
    for (const [method, params] of [
      ["resources/list", {}],
      ["resources/read", { uri: "file:///outside/secret" }],
      ["resources/templates/list", {}],
      ["prompts/list", {}],
      ["roots/list", {}],
      ["sampling/createMessage", { messages: [] }],
      ["elicitation/create", { message: "must-not-run" }],
    ]) {
      const response = await client.request(method, params);
      assertRejected(response, `${method} was exposed`);
    }
  });
});

test("SEC-02 filesystem traversal, alternate roots and URIs are rejected", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  await withBridge(t, async (client) => {
    const valid = await callContract(client, "fsRead", { ...fixture.vars, path: "README.md", startLine: 1, endLine: 1, maxBytes: 256 });
    assert.equal(hasError(valid), false, `valid filesystem read failed: ${redacted(valid)}`);
    assert.match(responseText(valid), /fixture README/);
    const candidates = [
      "../outside/outside-secret.txt",
      fixture.outsideFile,
      `C:\\outside\\${fixture.secrets[0]}`,
      "\\\\server\\share\\outside-secret.txt",
      "\\\\?\\C:\\outside\\outside-secret.txt",
      `${fixture.root}:secret-stream`,
      "/mnt/c/Users/Public/outside-secret.txt",
      "file:///outside/secret",
      ".GIT/config",
      ".Git/HEAD",
    ];
    for (const path of candidates) {
      const vars = { ...fixture.vars, path, root: fixture.root, rootAlias: fixture.vars.rootAlias };
      const response = await callContract(client, "fsRead", vars);
      assertRejected(response, `alternate path was accepted: ${path}`);
      assertNoSecret(response);
    }
    if (toolSpec("gitDiffUnstaged")) {
      for (const metadataPath of [".GIT/config", ".Git/HEAD"]) {
        const response = await callContract(client, "gitDiffUnstaged", { ...fixture.vars, path: metadataPath });
        assertRejected(response, `case-variant Git metadata path was accepted: ${metadataPath}`);
        assertNoSecret(response);
      }
    }
  });
});

test("SEC-03 symlink, junction and hardlink paths cannot expose outside content", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  const linkPath = join(fixture.root, "link-outside.txt");
  const junctionPath = join(fixture.root, "junction-outside");
  const hardlinkPath = join(fixture.root, "hardlink-outside.txt");
  let symlinkReady = false;
  let junctionReady = false;
  let hardlinkReady = false;
  try { await symlink(fixture.outsideUndetectedSecretFile, linkPath, "file"); symlinkReady = true; } catch { /* NOT_RUN below */ }
  try { await symlink(fixture.outside, junctionPath, "junction"); junctionReady = true; } catch { /* Windows privilege may deny */ }
  try { await link(fixture.outsideUndetectedSecretFile, hardlinkPath); hardlinkReady = true; } catch { /* volume/permission may deny */ }
  if (!symlinkReady && !junctionReady && !hardlinkReady) {
    t.skip("NOT_RUN: symlink/junction/hardlink creation unavailable on this host");
    return;
  }
  await withBridge(t, async (client) => {
    const paths = [];
    if (symlinkReady) paths.push(linkPath);
    if (junctionReady) paths.push(join(junctionPath, "outside-secret.txt"));
    if (hardlinkReady) paths.push(hardlinkPath);
    for (const path of paths) {
      const response = await callContract(client, "fsRead", { ...fixture.vars, path: fixturePath(path) });
      assertNoSecret(response, `link-like path exposed outside content: ${path}`);
      assertRejected(response, `link-like path was accepted: ${path}`);
    }
    if (junctionReady) {
      for (const [key, vars] of [
        ["fsList", { ...fixture.vars, path: "" }],
        ["fsFind", { ...fixture.vars, path: "", nameContains: "outside-secret" }],
        ["fsContentSearch", { ...fixture.vars, path: "", query: "client_secret" }],
      ]) {
        if (skipIfNoTool(t, key)) return;
        const response = await callContract(client, key, vars);
        assertNoSecret(response, `junction traversal exposed outside content via ${key}`);
        if (key === "fsList") {
          if (!hasError(response)) {
            assert.doesNotMatch(responseText(response), /junction-outside|outside-secret/u, "root listing exposed a junction target");
            assert.match(responseJson(response), /denied_count/iu, "root listing did not report filtered link-like entries");
          } else {
            assert.match(responseJson(response), /path_denied|path_changed|repository_denied/u, "junction listing failed with an unrelated or unsafe error");
          }
        } else {
          if (!hasError(response)) {
            assert.doesNotMatch(responseText(response), /junction-outside|outside-secret/u, `${key} exposed a junction target`);
            assert.match(responseJson(response), /denied_count/iu, `${key} did not report filtered link-like entries`);
          }
        }
      }
    }
  });
});

test("SEC-03 repeated replacement of a path does not cross the root", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  const raceDirectory = ownedPath(join(fixture.root, "race-junction"));
  const safeDirectory = ownedPath(join(fixture.root, "race-safe-directory"));
  const raceTarget = join(raceDirectory, "race-target.txt");
  const safeTarget = join(safeDirectory, "race-target.txt");
  const outsideTarget = join(fixture.outside, "race-target.txt");
  await mkdir(safeDirectory, { recursive: true });
  await writeFile(safeTarget, "safe race content\n", "utf8");
  await writeFile(outsideTarget, `client_secret=${fixture.clientSecret}\n`, "utf8");
  try { await symlink(fixture.outside, raceDirectory, "junction"); } catch {
    t.skip("NOT_RUN: directory junction creation unavailable for TOCTOU probe");
    return;
  }
  let stop = false;
  let replacements = 0;
  const toggle = (async () => {
    while (!stop) {
      try {
        await rm(raceDirectory, { force: true, recursive: false });
        await symlink(fixture.outside, raceDirectory, "junction");
        replacements += 1;
      } catch { /* junction may be busy while the bridge inspects it */ }
      try {
        await rm(raceDirectory, { force: true, recursive: false });
        await symlink(safeDirectory, raceDirectory, "junction");
        replacements += 1;
      } catch { /* junction may be busy while the bridge inspects it */ }
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
  })();
  try {
    await withBridge(t, async (client) => {
      for (let index = 0; index < 80; index += 1) {
        const response = await callContract(client, "fsRead", { ...fixture.vars, path: fixturePath(raceTarget) });
        assertNoSecret(response, "TOCTOU junction read exposed outside content");
      }
    });
  } finally {
    stop = true;
    await toggle;
  }
  assert.ok(replacements > 0, "TOCTOU junction was created but could not be replaced during the probe");
});

test("SEC-06 filesystem content search finds content by query, not filename", async (t) => {
  if (skipIfNoTool(t, "fsContentSearch")) return;
  const target = join(fixture.repo, "content-search.txt");
  await writeFile(target, "BRIDGE_CONTENT_CANARY_20260910 appears only in file content\n", "utf8");
  await withBridge(t, async (client) => {
    const response = await callContract(client, "fsContentSearch", { ...fixture.vars, path: "", query: fixture.vars.query });
    assert.equal(hasError(response), false, `content search failed: ${redacted(response)}`);
    assert.match(responseText(response), /BRIDGE_CONTENT_CANARY_20260910/);
    assert.equal(responseText(response).includes("content-search.txt"), true, "content search did not identify the matching file");
  });
});

test("SEC-06 filesystem find is a path search distinct from content search", async (t) => {
  if (skipIfNoTool(t, "fsFind")) return;
  const target = join(fixture.repo, "FILENAME_CANARY_20260910.txt");
  await writeFile(target, "content deliberately does not contain the filename query\n", "utf8");
  await withBridge(t, async (client) => {
    const response = await callContract(client, "fsFind", {
      ...fixture.vars,
      path: "",
      nameContains: "FILENAME_CANARY_20260910",
    });
    assert.equal(hasError(response), false, `path search failed: ${redacted(response)}`);
    assert.match(responseText(response), /FILENAME_CANARY_20260910\.txt/);
  });
});

test("SEC-08 sensitive filesystem search is denied or redacted", async (t) => {
  if (skipIfNoTool(t, "fsContentSearch") || skipIfNoTool(t, "fsRead")) return;
  await withBridge(t, async (client) => {
    const response = await callContract(client, "fsContentSearch", { ...fixture.vars, path: "", query: fixture.clientSecret });
    assertNoSecret(response);
    if (!hasError(response)) {
      const structured = response?.result?.structuredContent ?? response?.structuredContent;
      const noMatchesAfterDenial = Array.isArray(structured?.matches) && structured.matches.length === 0 && Number(structured?.denied_count) > 0;
      assert.equal(noMatchesAfterDenial || responseText(response).includes("<REDACTED>"), true, "sensitive search neither denied its match nor marked redaction");
    }
    const unclassified = await callContract(client, "fsRead", { ...fixture.vars, path: "app-config.json" });
    assertNoSecret(unclassified, "regex-shaped secret content was returned by direct read");
    if (!hasError(unclassified)) assert.match(responseJson(unclassified), /REDACTED|redacted|omitted/i, "unclassified secret read had no redaction marker");
    for (const path of [".env", "credentials.json", "private.pem"]) {
      const read = await callContract(client, "fsRead", { ...fixture.vars, path });
      assertRejected(read, `sensitive path was readable: ${path}`);
      assertNoSecret(read);
    }
  });
});

test("SEC-05 bounded reads return an explicit incomplete result", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  const large = join(fixture.repo, "large.txt");
  await writeFile(large, `${"0123456789abcdef".repeat(1024)}\n`, "utf8");
  await withBridge(t, async (client) => {
    const vars = { ...fixture.vars, path: fixturePath(large), startLine: 1, endLine: 100, maxBytes: 64 };
    const response = await callContract(client, "fsRead", vars);
    assert.equal(hasError(response), false, `bounded read failed: ${redacted(response)}`);
    const body = responseText(response);
    assert.ok(Buffer.byteLength(body, "utf8") <= 4096, `bounded response is unexpectedly large: ${body.length}`);
    const json = responseJson(response);
    assert.ok(/truncat|cursor|next[_-]?page|next[_-]?cursor/i.test(json), `bounded response lacks continuation metadata: ${redacted(response)}`);
  });
});

test("SEC-05 read continuation preserves bytes after the output boundary", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  const paged = join(fixture.repo, "paged-read.txt");
  const pagedLines = Array.from({ length: 80 }, (_, index) => `PAGE_LINE_${String(index + 1).padStart(3, "0")}_${"x".repeat(48)}`);
  await writeFile(paged, `${pagedLines.join("\n")}\n`, "utf8");
  const longLine = join(fixture.repo, "long-line-read.txt");
  await writeFile(longLine, `${"y".repeat(4096)}LONG_LINE_TAIL_CANARY_20260910\nlater line\n`, "utf8");
  await withBridge(t, async (client) => {
    const readPages = async (pathValue, endLine, maxBytes) => {
      const chunks = [];
      let startLine = 1;
      let cursor;
      for (let page = 0; page < 100; page += 1) {
        const response = await callContract(client, "fsRead", {
          ...fixture.vars,
          path: fixturePath(pathValue),
          startLine,
          endLine,
          maxBytes,
          readCursor: cursor,
        });
        assert.equal(hasError(response), false, `read page ${page + 1} failed (cursor=${String(cursor || "<none>").slice(0, 180)}): ${redacted(response)}`);
        const body = response?.result?.structuredContent ?? response?.structuredContent;
        chunks.push(body?.text || "");
        if (!body?.truncated) return { chunks, body };
        cursor = body.next_cursor;
        assert.equal(typeof cursor, "string", `read page ${page + 1} lacked a continuation cursor`);
        startLine = undefined;
      }
      assert.fail("read continuation exceeded 100 pages without reaching EOF");
    };

    const pagedResult = await readPages(paged, pagedLines.length, 256);
    const combined = pagedResult.chunks.join("");
    assert.match(combined, /PAGE_LINE_001/u);
    assert.match(combined, /PAGE_LINE_080/u, "continuation cursor skipped data after the first output boundary");

    const longResult = await readPages(longLine, 2, 128);
    const longCombined = longResult.chunks.join("");
    assert.match(longCombined, /LONG_LINE_TAIL_CANARY_20260910/u, "long-line continuation lost bytes from the truncated line");
  });
});

test("SEC-08 forged or cross-file read cursors cannot bypass content screening", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  const target = join(fixture.repo, "cursor-secret.txt");
  const secretLine = `client_secret=${fixture.clientSecret}\n`;
  await writeFile(target, secretLine, "utf8");
  const origin = join(fixture.repo, "cursor-origin.txt");
  await writeFile(origin, `origin header\n${"z".repeat(512)}\n`, "utf8");
  const crossTarget = join(fixture.repo, "cursor-cross-target.txt");
  await writeFile(crossTarget, `target header\n${secretLine}`, "utf8");
  const forged = Buffer.from(JSON.stringify({ v: 1, line: 1, offset: "client_secret=".length, skip: 0 })).toString("base64url");
  await withBridge(t, async (client) => {
    const forgedResponse = await callContract(client, "fsRead", {
      ...fixture.vars,
      path: fixturePath(target),
      startLine: 1,
      endLine: 1,
      maxBytes: 256,
      readCursor: forged,
    });
    const originResponse = await callContract(client, "fsRead", {
      ...fixture.vars,
      path: fixturePath(origin),
      startLine: 2,
      endLine: 2,
      maxBytes: 64,
    });
    assert.equal(hasError(originResponse), false, `origin read for cross-file cursor failed: ${redacted(originResponse)}`);
    const originBody = originResponse?.result?.structuredContent ?? originResponse?.structuredContent;
    assert.equal(typeof originBody?.next_cursor, "string", "origin read lacked a continuation cursor");
    const crossResponse = await callContract(client, "fsRead", {
      ...fixture.vars,
      path: fixturePath(crossTarget),
      startLine: undefined,
      endLine: 2,
      maxBytes: 256,
      readCursor: originBody.next_cursor,
    });
    const leaks = [
      [forgedResponse, "a forged cursor exposed the suffix of a protected line"],
      [crossResponse, "a cursor from another file exposed protected content"],
    ].filter(([response]) => fixture.secrets.some((secret) => responseJson(response).includes(secret)));
    assert.deepEqual(leaks, [], leaks.map(([, label]) => label).join("; "));
    for (const [response, label] of [[forgedResponse, "forged cursor"], [crossResponse, "cross-file cursor"]]) {
      if (!hasError(response) && !/REDACTED|redacted|omitted/i.test(responseJson(response))) {
        assert.fail(`${label} returned unmarked content: ${redacted(response)}`);
      }
    }
  });
});

test("F6 same-size replacement invalidates an earlier read cursor", async (t) => {
  if (skipIfNoTool(t, "fsRead")) return;
  const target = join(fixture.repo, "f6-stale-cursor.txt");
  const oldPrefix = "F6_OLD_CONTENT_CANARY_20260910_";
  const newPrefix = "F6_NEW_CONTENT_CANARY_20260910_";
  const oldContent = `${oldPrefix}${"a".repeat(512)}\n`;
  const newContent = `${newPrefix}${"b".repeat(oldContent.length - newPrefix.length - 1)}\n`;
  assert.equal(Buffer.byteLength(newContent, "utf8"), Buffer.byteLength(oldContent, "utf8"), "stale-cursor fixture is not same-size");
  await writeFile(target, oldContent, "utf8");
  await withBridge(t, async (client) => {
    const first = await callContract(client, "fsRead", {
      ...fixture.vars,
      path: fixturePath(target),
      startLine: 1,
      endLine: 1,
      maxBytes: 64,
    });
    assert.equal(hasError(first), false, `initial cursor read failed: ${redacted(first)}`);
    const firstBody = first?.result?.structuredContent ?? first?.structuredContent;
    assert.equal(firstBody?.truncated, true, `initial cursor read was not truncated: ${redacted(first)}`);
    assert.equal(typeof firstBody?.next_cursor, "string", `initial cursor read lacked a continuation token: ${redacted(first)}`);

    await writeFile(target, newContent, "utf8");
    const stale = await callContract(client, "fsRead", {
      ...fixture.vars,
      path: fixturePath(target),
      startLine: undefined,
      endLine: 1,
      maxBytes: 64,
      readCursor: firstBody.next_cursor,
    });
    assertRejected(stale, "same-size replacement accepted a cursor from the previous file state");
    assert.match(responseJson(stale), /cursor_stale|path_changed|changed|stale/i, `stale cursor failed without an explicit state-change reason: ${redacted(stale)}`);
    assertNoSecret(stale);
  });
});

test("F6 simulated local baseline invalidates old content after an uncommitted edit", async (t) => {
  if (skipIfNoTool(t, "fsRead") || skipIfNoTool(t, "gitStatus") || skipIfNoTool(t, "gitHead") || skipIfNoTool(t, "gitRef")) return;
  // SIMULATED local-only integration: this uses the authorized stdio harness,
  // not ChatGPT, a tunnel, or an MCP server-to-client callback.
  const target = join(fixture.repo, "f6-local-change.txt");
  const baselineText = "F6_BASELINE_CONTENT_20260910\n";
  const changedText = "F6_CHANGED_CONTENT_20260910\n";
  await writeFile(target, baselineText, "utf8");
  await git(fixture.repo, ["add", "f6-local-change.txt"]);
  await git(fixture.repo, ["commit", "-m", "f6 local baseline"]);
  const baselineContentHash = await sha256(target);
  const baselineIndexHash = await sha256(fixture.indexPath);
  const baselineRefs = (await git(fixture.repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"])).stdout;
  const baselineRefsHash = sha256Text(baselineRefs);
  const baselineHead = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();

  await withBridge(t, async (client) => {
    const head = await callContract(client, "gitHead", { ...fixture.vars, repo: fixture.repo });
    assert.equal(hasError(head), false, `baseline git_head failed: ${redacted(head)}`);
    assert.match(responseText(head), new RegExp(baselineHead), "baseline HEAD did not match the local snapshot");
    const ref = await callContract(client, "gitRef", { ...fixture.vars, repo: fixture.repo, revision: baselineHead });
    assert.equal(hasError(ref), false, `baseline git_ref failed: ${redacted(ref)}`);
    assert.match(responseText(ref), /["']?exists["']?\s*:\s*true/iu, "git_ref did not verify the baseline SHA");

    await writeFile(target, changedText, "utf8");
    const status = await callContract(client, "gitStatus", { ...fixture.vars, repo: fixture.repo });
    assert.equal(hasError(status), false, `status after local edit failed: ${redacted(status)}`);
    assert.match(responseText(status), /f6-local-change\.txt/u, "status did not expose the uncommitted local edit");
    const freshRead = await callContract(client, "fsRead", {
      ...fixture.vars,
      path: fixturePath(target),
      startLine: 1,
      endLine: 1,
      maxBytes: 256,
    });
    assert.equal(hasError(freshRead), false, `fresh local read failed: ${redacted(freshRead)}`);
    assert.match(responseText(freshRead), /F6_CHANGED_CONTENT_20260910/u, "fresh read returned the old baseline content");
    assert.notEqual(await sha256(target), baselineContentHash, "content hash was not invalidated by the local edit");
    assert.equal(await sha256(fixture.indexPath), baselineIndexHash, "local unstaged edit changed the Git index");
    const currentRefs = (await git(fixture.repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"])).stdout;
    assert.equal(sha256Text(currentRefs), baselineRefsHash, "local unstaged edit changed Git refs");
    const currentHead = await callContract(client, "gitHead", { ...fixture.vars, repo: fixture.repo });
    assert.match(responseText(currentHead), new RegExp(baselineHead), "local unstaged edit moved HEAD");
  });
});

test("SEC-05 concurrent filesystem operations are bounded", async (t) => {
  if (skipIfNoTool(t, "fsContentSearch")) return;
  for (let index = 0; index < 400; index += 1) {
    await writeFile(join(fixture.repo, `concurrency-${index}.txt`), `safe content ${index}\n`, "utf8");
  }
  await withBridge(t, async (client) => {
    const query = "NO_CONCURRENCY_MATCH_20260910";
    const results = await Promise.all([
      callContract(client, "fsContentSearch", { ...fixture.vars, path: "", query, maxMatches: 3 }),
      callContract(client, "fsContentSearch", { ...fixture.vars, path: "", query, maxMatches: 3 }),
    ]);
    const limited = results.find((response) => hasError(response));
    assert.ok(limited, `both concurrent operations completed: ${redacted(results)}`);
    assert.match(responseJson(limited), /concurr|in.?flight|busy/i, `concurrent rejection lacked a bounded-operation code: ${redacted(limited)}`);
  });
});

test("SEC-06 Git status preserves staged, unstaged and untracked distinctions", async (t) => {
  if (skipIfNoTool(t, "gitStatus") || skipIfNoTool(t, "gitDiffStaged") || skipIfNoTool(t, "gitDiffUnstaged")) return;
  await writeFile(join(fixture.repo, "staged.txt"), "staged baseline\nSTAGED_MARKER\n", "utf8");
  await git(fixture.repo, ["add", "staged.txt"]);
  await writeFile(join(fixture.repo, "unstaged.txt"), "unstaged baseline\nUNSTAGED_MARKER\n", "utf8");
  await writeFile(join(fixture.repo, "new file ñ.txt"), "UNTRACKED_MARKER\n", "utf8");
  const indexBefore = await sha256(fixture.indexPath);
  const headBefore = (await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim();
  await withBridge(t, async (client) => {
    const status = await callContract(client, "gitStatus", { ...fixture.vars, repo: fixture.repo, repoAlias: fixture.vars.repoAlias });
    assert.equal(hasError(status), false, `git status failed: ${redacted(status)}`);
    const statusText = responseText(status);
    assert.match(statusText, /staged\.txt/);
    assert.match(statusText, /unstaged\.txt/);
    assert.match(statusText, /new file ñ\.txt/);
    const staged = await callContract(client, "gitDiffStaged", { ...fixture.vars, path: undefined, repo: fixture.repo });
    const unstaged = await callContract(client, "gitDiffUnstaged", { ...fixture.vars, path: undefined, repo: fixture.repo });
    assert.equal(hasError(staged), false, `staged diff failed: ${redacted(staged)}`);
    assert.equal(hasError(unstaged), false, `unstaged diff failed: ${redacted(unstaged)}`);
    assert.match(responseText(staged), /STAGED_MARKER/);
    assert.equal(responseText(staged).includes("+UNSTAGED_MARKER"), false);
    assert.match(responseText(unstaged), /UNSTAGED_MARKER/);
    assert.equal(responseText(unstaged).includes("+STAGED_MARKER"), false);
  });
  assert.equal(await sha256(fixture.indexPath), indexBefore, "read-only Git calls changed the index");
  assert.equal((await git(fixture.repo, ["rev-parse", "HEAD"])).stdout.trim(), headBefore, "read-only Git calls moved HEAD");
});

test("SEC-06 git_diff requires an immutable reference SHA and paginates the exact CLI diff", async (t) => {
  if (skipIfNoTool(t, "gitDiffReference")) return;
  const target = join(fixture.repo, "src-main.js");
  await writeFile(target, "export const value = 'reference diff canary 20260910';\n", "utf8");
  const expected = (await git(fixture.repo, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=0", fixture.head, "--", "src-main.js",
  ])).stdout;
  assert.ok(expected.length > 64, "reference diff fixture did not exercise pagination");
  await withBridge(t, async (client) => {
    const missingReference = await client.call("git_diff", {
      repository: fixture.vars.repoAlias,
      path: "src-main.js",
      context_lines: 0,
      max_bytes: 64,
    });
    assertRejected(missingReference, "git_diff accepted a request without reference_sha");

    let cursor;
    const pages = [];
    for (let index = 0; index < 20; index += 1) {
      const response = await callContract(client, "gitDiffReference", {
        ...fixture.vars,
        repo: fixture.repo,
        revision: fixture.head,
        path: "src-main.js",
        contextLines: 0,
        maxBytes: 64,
        diffCursor: cursor,
      });
      assert.equal(hasError(response), false, `reference diff page ${index + 1} failed: ${redacted(response)}`);
      const body = response?.result?.structuredContent ?? response?.structuredContent;
      assert.equal(body?.reference_sha, fixture.head, "reference diff did not echo the requested immutable SHA");
      pages.push(body?.diff || "");
      if (!body?.truncated) break;
      cursor = body.next_cursor;
      assert.equal(typeof cursor, "string", `reference diff page ${index + 1} lacked a cursor`);
      if (index === 19) assert.fail("reference diff exceeded the pagination test bound");
    }
    assert.equal(pages.join(""), expected, "paginated git_diff content differs from the same-SHA safe Git CLI output");
  });
});

test("SEC-06 Git log/head/ref use an allowlisted immutable SHA and bounded history", async (t) => {
  if (skipIfNoTool(t, "gitLog") || skipIfNoTool(t, "gitHead") || skipIfNoTool(t, "gitRef")) return;
  await withBridge(t, async (client) => {
    const head = await callContract(client, "gitHead", { ...fixture.vars, repo: fixture.repo, revision: fixture.head });
    assert.equal(hasError(head), false, `git head failed: ${redacted(head)}`);
    assert.match(responseText(head), new RegExp(fixture.head.slice(0, 8)));
    const log = await callContract(client, "gitLog", { ...fixture.vars, path: undefined, repo: fixture.repo, maxCount: 1, limit: 1 });
    assert.equal(hasError(log), false, `git log failed: ${redacted(log)}`);
    assert.ok(responseText(log).length < 12000, "git log ignored the output bound");
    const branch = await callContract(client, "gitRef", { ...fixture.vars, repo: fixture.repo, revision: "main" });
    assertRejected(branch, "mutable branch revision was accepted");
    const traversal = await callContract(client, "gitRef", { ...fixture.vars, repo: fixture.repo, revision: "HEAD^{/fixture}" });
    assertRejected(traversal, "non-immutable revision expression was accepted");
  });
});

test("SEC-07 Git history and diff secrets are not returned", async (t) => {
  if (skipIfNoTool(t, "gitLog") || skipIfNoTool(t, "gitDiffUnstaged")) return;
  const secretDiff = join(fixture.repo, "secret-diff.txt");
  const trackedEnv = join(fixture.repo, ".env");
  await writeFile(secretDiff, "safe diff baseline\n", "utf8");
  await git(fixture.repo, ["add", "secret-diff.txt"]);
  await git(fixture.repo, ["commit", "-m", "fixture diff baseline"]);
  await writeFile(secretDiff, `client_secret=${fixture.clientSecret}\n`, "utf8");
  // Force-track the ignored environment file so an unscoped diff must apply
  // the same path policy as status, even though the content shape is unknown.
  await git(fixture.repo, ["add", "-f", ".env"]);
  await git(fixture.repo, ["commit", "-m", "fixture tracked environment baseline"]);
  await writeFile(trackedEnv, `client_secret=${fixture.clientSecret}\n`, "utf8");
  await withBridge(t, async (client) => {
    const leaks = [];
    const record = (response, label) => {
      if (fixture.secrets.some((secret) => responseJson(response).includes(secret))) leaks.push(label);
    };
    const log = await callContract(client, "gitLog", { ...fixture.vars, path: undefined, repo: fixture.repo, maxCount: 10, limit: 10 });
    record(log, "git history exposed a synthetic token");
    const diff = await callContract(client, "gitDiffUnstaged", { ...fixture.vars, repo: fixture.repo, path: "secret-diff.txt" });
    record(diff, "unstaged Git diff exposed a synthetic token");
    await git(fixture.repo, ["add", "secret-diff.txt"]);
    const staged = await callContract(client, "gitDiffStaged", { ...fixture.vars, repo: fixture.repo, path: "secret-diff.txt" });
    record(staged, "staged Git diff exposed a synthetic token");
    const unscoped = await callContract(client, "gitDiffUnstaged", { ...fixture.vars, path: undefined, repo: fixture.repo });
    record(unscoped, "unscoped Git diff exposed a synthetic token");
    assert.deepEqual(leaks, [], leaks.join("; "));
  });
});

test("SEC-07 external diff and textconv helpers never execute", async (t) => {
  if (skipIfNoTool(t, "gitDiffUnstaged")) return;
  const externalMarker = join(fixture.root, "external-diff.marker");
  const textconvMarker = join(fixture.root, "textconv.marker");
  const cleanMarker = join(fixture.root, "clean-filter.marker");
  const externalScript = join(fixture.root, "external-diff.cmd");
  const textconvScript = join(fixture.root, "textconv.cmd");
  const cleanScript = join(fixture.root, "clean-filter.cmd");
  if (process.platform === "win32") {
    await writeFile(externalScript, `@echo off\r\necho EXT_DIFF_EXECUTED>>"${externalMarker}"\r\nexit /b 0\r\n`, "utf8");
    await writeFile(textconvScript, `@echo off\r\necho TEXTCONV_EXECUTED>>"${textconvMarker}"\r\necho TEXTCONV_OUTPUT\r\n`, "utf8");
    await writeFile(cleanScript, `@echo off\r\necho CLEAN_FILTER_EXECUTED>>"${cleanMarker}"\r\nexit /b 0\r\n`, "utf8");
  } else {
    await writeFile(externalScript, `#!/bin/sh\necho EXT_DIFF_EXECUTED >> "${externalMarker}"\nexit 0\n`, "utf8");
    await writeFile(textconvScript, `#!/bin/sh\necho TEXTCONV_EXECUTED >> "${textconvMarker}"\necho TEXTCONV_OUTPUT\n`, "utf8");
    await writeFile(cleanScript, `#!/bin/sh\necho CLEAN_FILTER_EXECUTED >> "${cleanMarker}"\ncat\n`, "utf8");
    await chmod(externalScript, 0o700);
    await chmod(textconvScript, 0o700);
    await chmod(cleanScript, 0o700);
  }
  await git(fixture.repo, ["config", "diff.external", externalScript]);
  await writeFile(join(fixture.repo, ".gitattributes"), "*.bin diff=fixture-textconv\nfilter-trigger.txt filter=fixture-clean\n", "utf8");
  await writeFile(join(fixture.repo, "payload.bin"), Buffer.from([0, 1, 2, 3, 4]));
  await writeFile(join(fixture.repo, "filter-trigger.txt"), "clean filter baseline\n", "utf8");
  await git(fixture.repo, ["config", "diff.fixture-textconv.textconv", textconvScript]);
  await git(fixture.repo, ["add", ".gitattributes", "payload.bin", "filter-trigger.txt"]);
  await git(fixture.repo, ["commit", "-m", "fixture helper baseline"]);
  // Configure the clean filter only after the baseline commit. This keeps the
  // setup from creating the marker and makes a marker during bridge diff a
  // direct observation of helper execution by the code under test.
  await git(fixture.repo, ["config", "filter.fixture-clean.clean", cleanScript]);
  await writeFile(join(fixture.repo, "payload.bin"), Buffer.from([0, 1, 2, 9, 9]));
  await writeFile(join(fixture.repo, "filter-trigger.txt"), "clean filter changed\n", "utf8");
  await writeFile(join(fixture.repo, "helper-trigger.txt"), "helper diff trigger\n", "utf8");
  await withBridge(t, async (client) => {
    const response = await callContract(client, "gitDiffUnstaged", { ...fixture.vars, path: undefined, repo: fixture.repo });
    assertNoMarker(externalMarker, "EXT_DIFF_EXECUTED");
    assertNoMarker(textconvMarker, "TEXTCONV_EXECUTED");
    assertNoMarker(cleanMarker, "CLEAN_FILTER_EXECUTED");
    if (!hasError(response)) assertNoSecret(response);
  });
});

test("SEC-09 unapproved projects and repositories are rejected", async (t) => {
  if (skipIfNoTool(t, "gitStatus") || skipIfNoTool(t, "fsList")) return;
  await withBridge(t, async (client) => {
    const foreignRepo = join(fixture.outside, "foreign.git");
    await mkdir(foreignRepo, { recursive: true });
    await git(foreignRepo, ["init"]);
    const unknownRepo = await callContract(client, "gitStatus", { ...fixture.vars, repo: foreignRepo, repoAlias: "not-allowed" });
    assertRejected(unknownRepo, "unapproved repository was accepted");
    const unknownRoot = await callContract(client, "fsList", { ...fixture.vars, path: fixture.outside, root: fixture.outside, rootAlias: "not-allowed" });
    assertRejected(unknownRoot, "unapproved root was accepted");
  });
});

test("SEC-10 result limits and cursors are explicit", async (t) => {
  if (skipIfNoTool(t, "fsList")) return;
  for (let index = 0; index < 40; index += 1) await writeFile(join(fixture.root, `entry-${index}.txt`), `${index}\n`, "utf8");
  await withBridge(t, async (client) => {
    const response = await callContract(client, "fsList", { ...fixture.vars, path: "", maxEntries: 3, maxBytes: 512 });
    assert.equal(hasError(response), false, `bounded list failed: ${redacted(response)}`);
    const body = responseJson(response);
    assert.ok(/truncat|cursor|next[_-]?page|next[_-]?cursor/i.test(body), `list has no continuation metadata: ${redacted(response)}`);
  });
});

test("SEC-13 upstream/transport failure closes fail-closed and leaves no child", async (t) => {
  if (!configured) { t.skip("BLOCKED: no bridge command configured"); return; }
  const client = await BridgeClient.start();
  const gitDir = join(fixture.repo, ".git");
  const movedGitDir = join(fixture.repo, ".git-unavailable");
  try {
    await rename(gitDir, movedGitDir);
    const response = await callContract(client, "gitStatus", { ...fixture.vars, repo: fixture.repo });
    assertRejected(response, "upstream Git failure was reported as a successful empty result");
    assertNoSecret(response);
    assert.equal(client.child.exitCode, null, "upstream failure unexpectedly killed the bridge transport");
  } finally {
    try { await rename(movedGitDir, gitDir); } catch { /* preserve the original failure for the assertion */ }
    await client.close().catch(() => {});
  }
  assert.ok(client.exit, "bridge child did not exit after controlled failure");
});

test("SEC-13 authentication and external tunnel remain explicitly unverified", (t) => {
  t.skip("NOT_RUN: real authenticated Secure MCP Tunnel is intentionally outside the local stdio black-box harness");
});
