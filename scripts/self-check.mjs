import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridge, getToolDefinitions, loadConfig, normalizeConfig } from "../src/bridge.mjs";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code}): ${stderr.slice(0, 200)}`)));
  });
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function waitForResponse(child, id) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`MCP response timeout: ${id}`)), 5_000);
    const onData = (chunk) => {
      child._mcpBuffer = (child._mcpBuffer || "") + chunk;
      const lines = child._mcpBuffer.split("\n");
      child._mcpBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== id) continue;
        clearTimeout(deadline);
        child.stdout.off("data", onData);
        resolve(message);
        return;
      }
    };
    child.stdout.on("data", onData);
  });
}

async function protocolCheck(configPath) {
  const expectedConfig = await loadConfig(configPath);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, CODESCOPE_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.resume();
  const request = async (id, method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return await waitForResponse(child, id);
  };
  try {
    const initialize = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codescope-self-check", version: "0.1.0" } });
    assert.equal(initialize.error, undefined);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await request(2, "tools/list");
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), getToolDefinitions(expectedConfig).map((tool) => tool.name));
    const resources = await request(3, "resources/list");
    assert.equal(resources.error.code, -32601);
    const hidden = await request(4, "tools/call", { name: "git_commit", arguments: {} });
    assert.equal(hidden.error.code, -32602);
    const read = await request(5, "tools/call", { name: "fs_read_text", arguments: { repository: "self-test", path: "safe.txt" } });
    assert.equal(read.result.isError, undefined);
    assert.equal(read.result.structuredContent.path, "safe.txt");
    const boundedRead = await request(6, "tools/call", { name: "fs_read_text", arguments: { repository: "self-test", path: "large.txt", max_bytes: 63_488 } });
    assert.ok(Buffer.byteLength(JSON.stringify(boundedRead), "utf8") <= 65_536);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
}

const tempRoot = await fs.realpath(os.tmpdir());
const temp = await fs.mkdtemp(path.join(tempRoot, "codescope-bridge-check-"));
const repo = path.join(temp, "fixture ü repo");
await fs.mkdir(repo);
try {
  await run("git", ["init", "--quiet", repo]);
  await run("git", ["-C", repo, "config", "user.name", "CodeScope Fixture"]);
  await run("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(repo, "safe.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(repo, "page-diff.txt"), Array.from({ length: 1_500 }, (_, index) => `base-${index + 1}`).join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(repo, ".env"), "OPENAI_API_KEY=sk-synthetic-only\n", "utf8");
  await fs.writeFile(path.join(repo, "app-config.json"), "client_secret=synthetic-only\n", "utf8");
  await run("git", ["-C", repo, "add", "--", "safe.txt", "page-diff.txt"]);
  await run("git", ["-C", repo, "commit", "--quiet", "-m", "fixture baseline"]);
  await fs.writeFile(path.join(repo, "secret-diff.txt"), "safe diff baseline\n", "utf8");
  await run("git", ["-C", repo, "add", "--", "secret-diff.txt"]);
  await run("git", ["-C", repo, "commit", "--quiet", "-m", "fixture secret baseline"]);
  await fs.writeFile(path.join(repo, "secret-diff.txt"), "client_secret=synthetic-diff-secret\n", "utf8");
  await fs.writeFile(path.join(repo, "history-secret.txt"), "history\n", "utf8");
  await run("git", ["-C", repo, "add", "--", "history-secret.txt"]);
  await run("git", ["-C", repo, "commit", "--quiet", "-m", "TOKEN=synthetic-history-secret"]);
  await fs.writeFile(path.join(repo, "safe.txt"), "alpha\nneedle\n", "utf8");
  await fs.writeFile(path.join(repo, "page-diff.txt"), Array.from({ length: 1_500 }, (_, index) => `changed-${index + 1}`).join("\n") + "\n", "utf8");
  await fs.writeFile(path.join(repo, "staged.txt"), "staged\n", "utf8");
  await fs.writeFile(path.join(repo, "untracked.txt"), "untracked\n", "utf8");
  await fs.writeFile(path.join(repo, "space ü.txt"), "unicode\n", "utf8");
  await fs.writeFile(path.join(repo, "range.txt"), Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`).join("\n"), "utf8");
  await run("git", ["-C", repo, "add", "--", "staged.txt", "space ü.txt"]);
  await fs.writeFile(path.join(repo, "large.txt"), "x".repeat(70_000), "utf8");

  const bridge = createBridge(normalizeConfig({
    git_binary: "git",
    default_repository: "self-test",
    repositories: { "self-test": { root: repo, read_only: true } },
    limits: { max_lines: 5_000 },
  }));
  await bridge.prepare();
  const beforeBaseline = await bridge.captureBaseline({});
  const indexPath = path.join(repo, ".git", "index");
  const beforeIndexBytes = await fs.readFile(indexPath);
  const beforeIndex = crypto.createHash("sha256").update(beforeIndexBytes).digest("hex");
  assert.equal(beforeBaseline.git.index.sha256, beforeIndex);
  assert.equal(beforeBaseline.git.index_sha256, beforeIndex);
  assert.equal(beforeBaseline.git.index.state, "present");
  assert.ok(Array.isArray(beforeBaseline.git.status.entries));
  assert.equal(beforeBaseline.codebase_memory.state, "closed");
  assert.match(beforeBaseline.worktree.identity, /^[0-9a-f]{64}$/);
  assert.equal(beforeBaseline.worktree_identity, beforeBaseline.worktree.identity);

  const read = await bridge.call("fs_read_text", { path: "safe.txt", start_line: 2, end_line: 2 });
  assert.equal(read.text, "needle\n");
  assert.equal(read.end_line, 2);
  await assert.rejects(() => bridge.call("fs_read_text", { path: "app-config.json" }), (error) => error.code === "secret_denied");
  const laterRange = await bridge.call("fs_read_text", { path: "range.txt", start_line: 2_500, end_line: 2_500 });
  assert.equal(laterRange.text, "line-2500\n");
  assert.equal(laterRange.end_line, 2_500);
  assert.equal(laterRange.truncated, true);
  const laterPage = await bridge.call("fs_read_text", { path: "range.txt", cursor: laterRange.next_cursor, max_bytes: 1024 });
  assert.ok(laterPage.text.startsWith("line-2501\n"));
  let laterText = laterPage.text;
  let laterCursor = laterPage.next_cursor;
  while (laterCursor) {
    const page = await bridge.call("fs_read_text", { path: "range.txt", cursor: laterCursor, max_bytes: 1024 });
    laterText += page.text;
    laterCursor = page.next_cursor;
  }
  assert.ok(laterText.includes("line-3000"));
  const listing = await bridge.call("fs_list", {});
  assert.ok(listing.entries.some((entry) => entry.path === "safe.txt"));
  assert.ok(!listing.entries.some((entry) => entry.path === ".env"));
  const search = await bridge.call("fs_search_content", { query: "needle" });
  assert.equal(search.matches[0].path, "safe.txt");
  const sensitiveSearch = await bridge.call("fs_search_content", { query: "client_secret" });
  assert.equal(sensitiveSearch.redacted, true);
  const found = await bridge.call("fs_find", { name_contains: "space" });
  assert.ok(found.entries.some((entry) => entry.path === "space ü.txt"));

  const status = await bridge.call("git_status", {});
  assert.match(status.head_sha, /^[0-9a-f]{40}$/);
  const head = await bridge.call("git_head", {});
  assert.equal(head.head_sha, status.head_sha);
  assert.equal((await bridge.call("git_ref", { revision_sha: status.head_sha })).exists, true);
  await assert.rejects(() => bridge.call("git_ref", { revision_sha: "main" }), (error) => error.code === "invalid_arguments");
  assert.ok(status.entries.some((entry) => entry.status === " M" && entry.path === "safe.txt"));
  assert.ok(status.entries.some((entry) => entry.status === "A " && entry.path === "staged.txt"));
  assert.ok(status.entries.some((entry) => entry.status === "??" && entry.path === "untracked.txt"));
  assert.ok(status.entries.some((entry) => entry.path === "space ü.txt"));
  assert.ok(!status.entries.some((entry) => entry.path === ".env"));
  await assert.rejects(() => bridge.call("git_diff_unstaged", {}), (error) => error.code === "secret_denied");
  assert.match((await bridge.call("git_diff_unstaged", { path: "safe.txt" })).diff, /needle/u);
  assert.match((await bridge.call("git_diff_staged", { path: "staged.txt" })).diff, /staged/u);
  const expectedUnstagedDiff = await run("git", ["-C", repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", "--", "page-diff.txt"]);
  let diffPage = await bridge.call("git_diff_unstaged", { path: "page-diff.txt", max_bytes: 4_096 });
  let pagedDiff = diffPage.diff;
  while (diffPage.next_cursor) {
    diffPage = await bridge.call("git_diff_unstaged", { path: "page-diff.txt", max_bytes: 4_096, cursor: diffPage.next_cursor });
    pagedDiff += diffPage.diff;
  }
  assert.equal(pagedDiff, expectedUnstagedDiff);
  const expectedReferenceDiff = await run("git", ["-C", repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", status.head_sha, "--", "page-diff.txt"]);
  let referencePage = await bridge.call("git_diff", { reference_sha: status.head_sha, path: "page-diff.txt", max_bytes: 4_096 });
  let pagedReferenceDiff = referencePage.diff;
  while (referencePage.next_cursor) {
    referencePage = await bridge.call("git_diff", { reference_sha: status.head_sha, path: "page-diff.txt", max_bytes: 4_096, cursor: referencePage.next_cursor });
    pagedReferenceDiff += referencePage.diff;
  }
  assert.equal(pagedReferenceDiff, expectedReferenceDiff);
  await assert.rejects(() => bridge.call("git_diff_unstaged", { path: "secret-diff.txt" }), (error) => error.code === "secret_denied");
  const sanitizedLog = await bridge.call("git_log", { revision_sha: status.head_sha, max_count: 10 });
  assert.ok(sanitizedLog.redacted >= 1);
  assert.equal(JSON.stringify(sanitizedLog).includes("synthetic-history-secret"), false);

  await fs.writeFile(path.join(repo, "cursor-version.txt"), "first\nsecond\n", "utf8");
  const versioned = await bridge.call("fs_read_text", { path: "cursor-version.txt", max_bytes: 2 });
  assert.ok(versioned.next_cursor);
  await fs.writeFile(path.join(repo, "cursor-version.txt"), "FIRST\nsecond\n", "utf8");
  await assert.rejects(() => bridge.call("fs_read_text", { path: "cursor-version.txt", cursor: versioned.next_cursor, max_bytes: 2 }), (error) => error.code === "cursor_stale");
  await fs.rm(path.join(repo, "cursor-version.txt"));

  const bounded = await bridge.call("fs_read_text", { path: "large.txt", max_bytes: 1024 });
  assert.equal(bounded.truncated, true);
  const tamperedCursor = `${bounded.next_cursor.slice(0, -1)}${bounded.next_cursor.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(() => bridge.call("fs_read_text", { path: "large.txt", cursor: tamperedCursor, max_bytes: 1024 }), (error) => error.code === "invalid_arguments");
  let largeText = bounded.text;
  let largeCursor = bounded.next_cursor;
  while (largeCursor) {
    const page = await bridge.call("fs_read_text", { path: "large.txt", cursor: largeCursor, max_bytes: 1024 });
    largeText += page.text;
    largeCursor = page.next_cursor;
  }
  assert.equal(largeText, "x".repeat(70_000));
  for (const unsafe of ["../outside", "C:/outside", "foo\\bar", ".git/config", ".GIT/config", ".Git/HEAD", "dir:name"]) {
    await assert.rejects(() => bridge.call("fs_read_text", { path: unsafe }), (error) => ["path_denied", "path_missing", "secret_denied"].includes(error.code));
  }
  await assert.rejects(() => bridge.call("fs_list", { unexpected: true }), (error) => error.code === "invalid_arguments");
  await assert.rejects(() => bridge.call("git_commit", {}), (error) => error.code === "tool_denied");
  await fs.writeFile(path.join(repo, "staged.txt"), "staged-index-probe\n", "utf8");
  await run("git", ["-C", repo, "add", "--", "staged.txt"]);
  const changedIndexBaseline = await bridge.captureBaseline({});
  assert.notEqual(changedIndexBaseline.git.index.sha256, beforeBaseline.git.index.sha256);
  await fs.writeFile(path.join(repo, "staged.txt"), "staged\n", "utf8");
  await fs.writeFile(indexPath, beforeIndexBytes);
  const afterBaseline = await bridge.captureBaseline({});
  const afterIndex = await sha256File(path.join(repo, ".git", "index"));
  assert.match(beforeBaseline.content.sha256, /^[0-9a-f]{64}$/);
  assert.equal(beforeBaseline.codebase_memory.state, "closed");
  assert.equal(beforeBaseline.git.status.entries.length, beforeBaseline.git.status_entries);
  assert.equal(beforeBaseline.git.index.sha256, beforeIndex);
  assert.equal(afterBaseline.git.index.sha256, afterIndex);
  assert.equal(afterBaseline.git.index_sha256, afterIndex);
  assert.equal(afterBaseline.content.sha256, beforeBaseline.content.sha256);
  assert.equal(afterBaseline.git.refs_sha256, beforeBaseline.git.refs_sha256);
  assert.equal(afterIndex, beforeIndex);
  await run("git", ["-C", repo, "config", "filter.synthetic.process", "node -e synthetic-helper"]);
  await assert.rejects(() => bridge.call("git_status", {}), (error) => error.code === "git_helpers_blocked");
  await run("git", ["-C", repo, "config", "--unset-all", "filter.synthetic.process"]);
  const configPath = path.join(temp, "bridge.json");
  await fs.writeFile(configPath, JSON.stringify({ git_binary: "git", default_repository: "self-test", repositories: { "self-test": { root: repo, read_only: true } }, limits: { max_lines: 5_000 } }), "utf8");
  await protocolCheck(configPath);
  console.log(JSON.stringify({ status: "PASS", checks: ["filesystem ranges/list/find/content", "git head/status/staged/unstaged/log/ref", "git reference diff and lossless pagination", "cursor version binding", "bounds", "secret/path denial", "hidden tool denial", "baseline content/refs/index unchanged", "Git helper hazard rejection", "stdio tools/list/tools/call and resources rejection"], repository: "self-test" }));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
