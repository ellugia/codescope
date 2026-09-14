import { open, readdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { Client } from "../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const config = join(root, "config", "fixture.json");
const fixture = join(root, "characterization", "fixture");
const outputPath = join(root, "tests", "measure-output.json");
const server = join(root, "src", "server.mjs");
const sessionRoot = process.env.CODEX_HOME || join(process.env.USERPROFILE || "", ".codex");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function countSessionMeta() {
  let count = 0;
  let files = 0;
  let unreadable = 0;
  const directory = join(sessionRoot, "sessions", "2026", "09", "10");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return { count: null, files: 0, unreadable: 1 }; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    files += 1;
    const full = join(directory, entry.name);
    let handle;
    try {
      handle = await open(full, "r");
      const first = await readFirstJsonLine(handle);
      const meta = first ? JSON.parse(first) : null;
      const source = meta?.payload?.source;
      if (meta?.type !== "session_meta" || source === undefined) unreadable += 1;
      else if (!isGuardianSource(source)) count += 1;
    } catch { unreadable += 1; }
    finally { try { await handle?.close(); } catch { unreadable += 1; } }
  }
  return { count: files > 0 && unreadable === 0 ? count : null, files, unreadable };
}

async function readFirstJsonLine(handle) {
  const chunks = [];
  let position = 0;
  let total = 0;
  while (total < 16 * 1024 * 1024) {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return null;
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(chunk);
    total += bytesRead;
    position += bytesRead;
  }
  return null;
}

function isGuardianSource(source) {
  return source?.role === "guardian"
    || source?.subagent?.role === "guardian"
    || source?.subagent?.other === "guardian"
    || source?.subagent?.thread_spawn?.agent_path === "/root/guardian";
}

function childEnv() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG", "LC_ALL"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.CODESCOPE_CONFIG = config;
  return env;
}

async function measureCall(client, name, args) {
  const started = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const elapsed = performance.now() - started;
    const responseJsonBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    return { status: result.isError ? "MCP_ERROR" : "PASS", elapsed_ms: Number(elapsed.toFixed(3)), response_json_bytes: responseJsonBytes };
  } catch (error) {
    return { status: "TRANSPORT_ERROR", elapsed_ms: Number((performance.now() - started).toFixed(3)), response_json_bytes: 0, error_kind: error?.name || "Error" };
  }
}

async function run() {
  const startedAt = new Date().toISOString();
  const sessionsBefore = await countSessionMeta();
  const client = new Client({ name: "codescope-readonly-measure", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root, env: childEnv(), stderr: "pipe" });
  let stderrBytes = 0;
  transport.stderr?.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); });
  let connected = false;
  let measurements = {};
  try {
    await client.connect(transport);
    connected = true;
    const tools = await client.listTools();
    const common = { repository: "fixture" };
    const calls = [
      ["fs_read_text", { ...common, path: "src/graph_fixture.py", start_line: 1, end_line: 80, max_bytes: 4096 }],
      ["git_status", { ...common, max_entries: 50, cursor: "0" }],
    ];
    for (const [name, args] of calls) {
      const samples = [];
      for (let index = 0; index < 3; index += 1) samples.push(await measureCall(client, name, args));
      measurements[name] = {
        samples,
        median_elapsed_ms: median(samples.map((sample) => sample.elapsed_ms)),
        median_response_json_bytes: median(samples.map((sample) => sample.response_json_bytes)),
      };
    }
    measurements.tools_list = { count: tools.tools?.length || 0, required_present: ["fs_read_text", "git_status"].every((name) => tools.tools?.some((tool) => tool.name === name)) };
  } finally {
    try { if (connected) await client.close(); } catch { /* close is best effort after measurement */ }
    try { await transport.close(); } catch { /* already closed */ }
  }
  const sessionsAfter = await countSessionMeta();
  const output = {
    schema: "codescope.measure.v1",
    scope: "READONLY local stdio MCP measurement; no ChatGPT, tunnel, inference API, or Codex control-plane call",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    config: "config/fixture.json",
    fixture: "characterization/fixture",
    calls_per_tool: 3,
    response_bytes_note: "response_json_bytes is JSON.stringify of the SDK-parsed MCP result, not exact wire bytes",
    session_meta: {
      before: sessionsBefore.count,
      after: sessionsAfter.count,
      delta: sessionsBefore.count === null || sessionsAfter.count === null ? null : sessionsAfter.count - sessionsBefore.count,
      status: sessionsBefore.count === null || sessionsAfter.count === null ? "UNVERIFIED" : "MEASURED",
      date_scope: "2026-09-10",
      files_before: sessionsBefore.files,
      files_after: sessionsAfter.files,
      unreadable_before: sessionsBefore.unreadable,
      unreadable_after: sessionsAfter.unreadable,
      guardian_filter: "payload.source exact Guardian-role exclusion; no payload output",
    },
    stderr_bytes: stderrBytes,
    measurements,
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

const result = await run();
console.log(JSON.stringify({ output: "tests/measure-output.json", session_meta: result.session_meta, measurements: result.measurements }, null, 2));
