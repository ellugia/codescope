import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../deps/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import {
  createBridge,
  getToolDefinitions,
  hasSecret,
  normalizeConfig,
  toSafeError,
} from "../src/bridge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config", "fixture.json");
const fixtureRoot = path.join(root, "characterization", "fixture");
const fixtureFiles = [
  ["fixture_git_index", path.join(fixtureRoot, ".git", "index")],
  ["fixture_git_head", path.join(fixtureRoot, ".git", "HEAD")],
  ["fixture_source", path.join(fixtureRoot, "src", "graph_fixture.py")],
];
const contextRoot = path.join(root, "characterization", "ctx-test");
const contextCorpus = path.join(contextRoot, "corpus");
const contextStorage = path.join(contextRoot, "storage-session");
const fixtureSourcePath = path.join(fixtureRoot, "src", "graph_fixture.py");
const contextCorpusPath = path.join(contextCorpus, "canary.md");
const qualifiedRoot = "CodeScope-fixture.src.graph_fixture.root_value";
const extraKeys = ["project", "root", "session", "source"];
const hiddenTools = ["index_repository", "delete_project", "ctx_execute", "ctx_index"];
const optionalTools = ["cbm_status", "cbm_search", "cbm_trace", "cbm_snippet", "context_mode_search"];

const checks = [];
let bridgeClient;
let bridgeTransport;

function record(name, status, details = {}) {
  checks.push({ name, status, ...details });
}

function summarizeError(raw) {
  if (raw?.result?.structuredContent?.error) return raw.result.structuredContent.error;
  if (raw?.rejected && Number(raw.rpc_code) === -32602 && /allowlist/iu.test(raw.rpc_message || "")) return "tool_denied";
  if (raw?.rejected) return "transport_rejected";
  return null;
}

function resultData(raw) {
  return raw?.result?.structuredContent && !raw.result.structuredContent.error
    ? raw.result.structuredContent
    : null;
}

async function callMcp(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { result, rejected: false };
  } catch (error) {
    return {
      rejected: true,
      rpc_code: error?.code ?? null,
      rpc_message: String(error?.message || ""),
    };
  }
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath);
  return {
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function snapshotDirectory(directory) {
  const rows = [];
  async function walk(current, relative) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(next, nextRelative);
      } else if (entry.isFile()) {
        rows.push({ path: nextRelative, ...(await hashFile(next)) });
      } else {
        throw new Error(`Unexpected non-file context storage entry: ${nextRelative}`);
      }
    }
  }
  await walk(directory, "");
  return rows;
}

async function snapshotAuthorizedState() {
  const fixture = {};
  for (const [name, filePath] of fixtureFiles) fixture[name] = await hashFile(filePath);
  return {
    fixture,
    context_corpus: await snapshotDirectory(contextCorpus),
    context_storage: await snapshotDirectory(contextStorage),
  };
}

async function snapshotCodeUnderTest() {
  const files = [
    ["src_bridge", path.join(root, "src", "bridge.mjs")],
    ["src_optional_backends", path.join(root, "src", "optional-backends.mjs")],
    ["src_server", path.join(root, "src", "server.mjs")],
    ["review_test", path.join(root, "tests", "optional-backends-review.mjs")],
  ];
  const result = {};
  for (const [name, filePath] of files) result[name] = await hashFile(filePath);
  return result;
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bridgeEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => value !== undefined && name.toLowerCase() !== "codescope_tunnel_runtime_key"),
  );
  env.CODESCOPE_CONFIG = configPath;
  return env;
}

async function connectBridge() {
  const client = new Client({ name: "codescope-optional-backends-review", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "server.mjs")],
    cwd: root,
    env: bridgeEnvironment(),
    stderr: "ignore",
  });
  await client.connect(transport);
  return { client, transport };
}

function toolArgs(name) {
  switch (name) {
    case "cbm_status": return {};
    case "cbm_search": return { query: "root_value", limit: 5, offset: 0 };
    case "cbm_trace": return { function_name: qualifiedRoot, direction: "both", depth: 1, limit: 5 };
    case "cbm_snippet": return { qualified_name: qualifiedRoot };
    case "context_mode_search": return { query: "canary", limit: 3 };
    default: throw new Error(`No canary arguments for ${name}`);
  }
}

function assertPositive(name, raw, expectedSource, expectedCorpus) {
  const data = resultData(raw);
  const error = summarizeError(raw);
  if (!data || error) throw new Error(`${name} returned ${error || "no structured result"}`);
  if (name === "cbm_status") {
    if (data.backend !== "codebase-memory" || data.project !== "CodeScope-fixture" || data.root_verified !== true) {
      throw new Error("cbm_status did not verify the authorized fixture project and root");
    }
  } else if (name === "cbm_search") {
    const serialized = JSON.stringify(data);
    if (!serialized.includes("root_value") || !serialized.includes("src/graph_fixture.py")) {
      throw new Error("cbm_search did not return the fixture canary");
    }
  } else if (name === "cbm_trace") {
    const serialized = JSON.stringify(data);
    if (data.function_name !== qualifiedRoot || !serialized.includes("leaf_value")) {
      throw new Error("cbm_trace did not return the authorized root-to-leaf call");
    }
  } else if (name === "cbm_snippet") {
    const startLine = Number(data.start_line);
    const endLine = Number(data.end_line);
    const sourceLines = expectedSource.split(/\r?\n/u);
    const expectedLines = Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine)
      ? sourceLines.slice(startLine - 1, endLine).join("\n") + (endLine < sourceLines.length ? "\n" : "")
      : null;
    if (data.path !== "src/graph_fixture.py" || expectedLines === null || data.source !== expectedLines) {
      throw new Error("cbm_snippet returned an unexpected fixture source scope");
    }
  } else if (name === "context_mode_search") {
    const expectedMarker = expectedCorpus.split(/\r?\n/u).find((line) => line.startsWith("CTX_"));
    const expectedSentence = expectedCorpus.split(/\r?\n/u).find((line) => line.startsWith("This fixture"));
    const serializedMatches = JSON.stringify(data.matches || []);
    if (
      data.backend !== "context-mode" ||
      data.scope !== "synthetic" ||
      data.source !== "ctx-canary" ||
      !Array.isArray(data.matches) ||
      data.matches.length < 1 ||
      !expectedMarker ||
      !expectedSentence ||
      !serializedMatches.includes(expectedMarker) ||
      !serializedMatches.includes(expectedSentence) ||
      !data.integrity?.corpus_unchanged ||
      !data.integrity?.storage_unchanged ||
      !data.integrity?.query_storage_isolated
    ) {
      throw new Error("context_mode_search did not return an isolated read-only canary result");
    }
  }
}

async function checkAdvertisedTools() {
  const listing = await bridgeClient.listTools();
  const names = listing.tools.map((tool) => tool.name);
  const missing = optionalTools.filter((name) => !names.includes(name));
  const hidden = hiddenTools.filter((name) => names.includes(name));
  if (missing.length || hidden.length) {
    record("advertised_tools", "FAIL", { missing_optional: missing, hidden_advertised: hidden });
    return names;
  }
  record("advertised_tools", "PASS", { optional: optionalTools });
  return names;
}

async function checkPositiveCalls(expectedSource, expectedCorpus) {
  for (const name of optionalTools) {
    const raw = await callMcp(bridgeClient, name, toolArgs(name));
    try {
      assertPositive(name, raw, expectedSource, expectedCorpus);
      record(`positive_${name}`, "PASS");
    } catch (error) {
      const code = summarizeError(raw);
      const status = ["backend_unavailable", "backend_call_failed", "timeout"].includes(code) ? "BLOCKED" : "FAIL";
      record(`positive_${name}`, status, { error_code: code || "contract_failure" });
    }
  }
}

async function checkExtraArguments() {
  for (const name of optionalTools) {
    const base = toolArgs(name);
    for (const key of extraKeys) {
      const args = { ...base, [key]: "foreign-test-value" };
      const raw = await callMcp(bridgeClient, name, args);
      const code = summarizeError(raw);
      if (code === "invalid_arguments") {
        record(`extra_${name}_${key}`, "PASS");
      } else {
        record(`extra_${name}_${key}`, "FAIL", { error_code: code || "accepted" });
      }
    }
  }
}

async function checkHiddenTools() {
  for (const name of hiddenTools) {
    const raw = await callMcp(bridgeClient, name, {});
    const code = summarizeError(raw);
    const rejectedByAllowlist = code === "tool_denied" && Number(raw.rpc_code) === -32602 && /allowlist/iu.test(raw.rpc_message || "");
    if (rejectedByAllowlist) record(`hidden_${name}`, "PASS", { rpc_code: -32602 });
    else record(`hidden_${name}`, "FAIL", { error_code: code || "accepted", rpc_code: raw.rpc_code ?? null });
  }
}

async function checkBoundaryAndSecretRejection() {
  const foreignTrace = await callMcp(bridgeClient, "cbm_trace", {
    function_name: "OtherProject.src.graph_fixture.root_value",
    direction: "both",
    depth: 1,
    limit: 1,
  });
  record("foreign_function_name", summarizeError(foreignTrace) === "project_boundary" ? "PASS" : "FAIL", {
    ...(summarizeError(foreignTrace) === "project_boundary" ? {} : { error_code: summarizeError(foreignTrace) || "accepted" }),
  });

  const foreignSnippet = await callMcp(bridgeClient, "cbm_snippet", { qualified_name: "OtherProject.src.graph_fixture.root_value" });
  record("foreign_qualified_name", summarizeError(foreignSnippet) === "project_boundary" ? "PASS" : "FAIL", {
    ...(summarizeError(foreignSnippet) === "project_boundary" ? {} : { error_code: summarizeError(foreignSnippet) || "accepted" }),
  });

  const outOfScopeTrace = await callMcp(bridgeClient, "cbm_trace", {
    function_name: "CodeScope-fixture.other.secret",
    direction: "both",
    depth: 1,
    limit: 1,
  });
  record("out_of_scope_function_name", summarizeError(outOfScopeTrace) === "project_boundary" ? "PASS" : "FAIL", {
    ...(summarizeError(outOfScopeTrace) === "project_boundary" ? {} : { error_code: summarizeError(outOfScopeTrace) || "accepted" }),
  });

  const outOfScopeSnippet = await callMcp(bridgeClient, "cbm_snippet", { qualified_name: "CodeScope-fixture.other.secret" });
  record("out_of_scope_qualified_name", summarizeError(outOfScopeSnippet) === "project_boundary" ? "PASS" : "FAIL", {
    ...(summarizeError(outOfScopeSnippet) === "project_boundary" ? {} : { error_code: summarizeError(outOfScopeSnippet) || "accepted" }),
  });

  const syntheticSecretQuery = ["API", "_KEY=synthetic-test-value"].join("");
  for (const name of ["cbm_search", "context_mode_search"]) {
    const raw = await callMcp(bridgeClient, name, name === "cbm_search" ? { query: syntheticSecretQuery, limit: 1 } : { query: syntheticSecretQuery, limit: 1 });
    const code = summarizeError(raw);
    const echoed = JSON.stringify(raw).includes(syntheticSecretQuery);
    const pass = code === "secret_denied" && !echoed;
    record(`secret_${name}`, pass ? "PASS" : "FAIL", {
      ...(pass ? {} : { error_code: code || "accepted", response_echoed_input: echoed }),
    });
  }
}

async function checkDisabledBackends(rawConfig) {
  for (const [backendName, toolName] of [["codebase_memory", "cbm_status"], ["context_mode", "context_mode_search"]]) {
    const isolatedRaw = JSON.parse(JSON.stringify(rawConfig));
    if (isolatedRaw.optional_backends.bindings?.fixture?.[backendName]) {
      isolatedRaw.optional_backends.bindings.fixture[backendName].enabled = false;
    }
    if (isolatedRaw.optional_backends[backendName]) {
      isolatedRaw.optional_backends[backendName].enabled = false;
    }
    const isolatedConfig = normalizeConfig(isolatedRaw);
    const isolatedBridge = createBridge(isolatedConfig);
    const advertised = getToolDefinitions(isolatedConfig).map((tool) => tool.name);
    const advertisedPass = !advertised.includes(toolName);
    let rejected = false;
    let errorCode = null;
    try {
      await isolatedBridge.call(toolName, toolArgs(toolName));
    } catch (error) {
      errorCode = toSafeError(error).code;
      rejected = errorCode === "tool_denied";
    }
    record(`disabled_${backendName}`, advertisedPass && rejected ? "PASS" : "FAIL", {
      advertised: advertisedPass ? "absent" : "present",
      direct_call: rejected ? "rejected" : "accepted",
      ...(advertisedPass && rejected ? {} : { error_code: errorCode || "accepted" }),
    });
  }
}

function overallStatus() {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (checks.some((check) => check.status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

function publicEvidence(before, after, advertisedNames, codeUnderTest) {
  const status = overallStatus();
  return {
    schema_version: 1,
    status,
    generated_utc: new Date().toISOString(),
    bridge: {
      entrypoint: "src/server.mjs",
      config: "config/fixture.json",
      advertised_optional_tools: advertisedNames.filter((name) => optionalTools.includes(name)),
      hidden_tools_absent: hiddenTools.every((name) => !advertisedNames.includes(name)),
    },
    checks,
    authorized_state: {
      before,
      after,
      unchanged: sameSnapshot(before, after),
    },
    code_under_test: codeUnderTest,
    secret_input: "synthetic_only_not_recorded",
    notes: [
      "Direct MCP stdio calls only; no repository or index ingestion was requested.",
      "Context Mode search was isolated by the bridge into an ephemeral storage copy.",
      "A positive backend failure is BLOCKED when the installed backend is unavailable; contract and security failures remain FAIL.",
      "The secret check covers bridge request rejection and response non-echo; no upstream secret-bearing backend result was injected.",
    ],
  };
}

async function main() {
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  const expectedSource = await fs.readFile(fixtureSourcePath, "utf8");
  const expectedCorpus = await fs.readFile(contextCorpusPath, "utf8");
  const before = await snapshotAuthorizedState();
  let advertisedNames = [];
  try {
    ({ client: bridgeClient, transport: bridgeTransport } = await connectBridge());
    advertisedNames = await checkAdvertisedTools();
    await checkPositiveCalls(expectedSource, expectedCorpus);
    await checkExtraArguments();
    await checkHiddenTools();
    await checkBoundaryAndSecretRejection();
    await checkDisabledBackends(rawConfig);
  } catch (error) {
    const transportCode = typeof error?.code === "string" ? `transport_${error.code.toLowerCase()}` : "bridge_unavailable";
    record("bridge_transport", "BLOCKED", { error_code: transportCode });
  } finally {
    try { await bridgeClient?.close(); } catch { }
    try { await bridgeTransport?.close(); } catch { }
  }
  const after = await snapshotAuthorizedState();
  const codeUnderTest = await snapshotCodeUnderTest();
  if (!sameSnapshot(before, after)) record("authorized_state_unchanged", "FAIL", { error_code: "authorized_state_changed" });
  else record("authorized_state_unchanged", "PASS");

  const evidence = publicEvidence(before, after, advertisedNames, codeUnderTest);
  if (hasSecret(JSON.stringify(evidence))) throw new Error("Refusing to emit evidence that matches a secret pattern");
  await fs.writeFile(path.join(root, "characterization", "backends-review", "result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: evidence.status, checks: checks.length, state_unchanged: evidence.authorized_state.unchanged })}\n`);
  process.exitCode = evidence.status === "PASS" ? 0 : evidence.status === "BLOCKED" ? 2 : 1;
}

await main();
