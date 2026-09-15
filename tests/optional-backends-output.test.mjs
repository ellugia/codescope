import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOptionalBackends } from "../src/optional-backends.mjs";
import { hasSecret, verifyNoReparse } from "../src/bridge.mjs";

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "codescope-optional-output-"));
const sourceRoot = path.join(root, "fixture");
const sourceFile = path.join(sourceRoot, "src", "graph_fixture.py");
const stub = path.resolve("tests/fixtures/optional-backend-stub.mjs");
const project = "CodeScope-fixture";
const checks = [];

await fs.mkdir(path.dirname(sourceFile), { recursive: true });
await fs.writeFile(sourceFile, "def safe():\n    return 'fixture'\n", "utf8");

function record(name, status, details = {}) {
  checks.push({ name, status, ...details });
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function makeConfig(mode, pidFile) {
  return {
    limits: { maxResponseBytes: 65_536, timeoutMs: 5_000 },
    optionalBackends: {
      codebaseMemory: {
        command: process.execPath,
        args: [stub],
        cwd: sourceRoot,
        env: {
          OPTIONAL_STUB_MODE: mode,
          OPTIONAL_STUB_PROJECT: project,
          OPTIONAL_STUB_ROOT: sourceRoot,
          ...(pidFile ? { OPTIONAL_STUB_PID_FILE: pidFile } : {}),
        },
        project,
        root: sourceRoot,
        allowedPaths: ["src/graph_fixture.py"],
      },
      contextMode: null,
    },
  };
}

function backends(mode, pidFile) {
  return createOptionalBackends(makeConfig(mode, pidFile), { hasSecret, verifyNoReparse });
}

async function expectError(name, operation, expected) {
  try {
    const value = await operation();
    record(name, "FAIL", { error_code: "accepted", value_leaked: containsForeignOrSecret(value) });
  } catch (error) {
    const code = errorCode(error);
    const accepted = Array.isArray(expected) ? expected.includes(code) : code === expected;
    record(name, accepted ? "PASS" : "FAIL", { error_code: code || "unknown" });
  }
}

function containsForeignOrSecret(value) {
  const text = JSON.stringify(value);
  return text.includes("synthetic-output-secret") || text.includes("OtherProject") || text.includes("outside.py");
}

async function run() {
  const safe = backends("safe");
  const search = await safe.cbmSearch({ query: "safe_query", limit: 10 });
  assert.equal(containsForeignOrSecret(search), false);
  assert.equal(search.count, 1);
  record("search_filters_foreign_rows", "PASS", { returned_rows: search.count });

  await expectError("search_rejects_secret_in_allowed_row", () => backends("secret-search").cbmSearch({ query: "safe_query", limit: 1 }), "secret_denied");
  await expectError("snippet_rejects_foreign_path", () => backends("foreign-snippet-path").cbmSnippet({ qualified_name: `${project}.src.graph_fixture.safe` }), "project_boundary");

  try {
    const result = await backends("foreign-snippet-project").cbmSnippet({ qualified_name: `${project}.src.graph_fixture.safe` });
    if (containsForeignOrSecret(result)) record("snippet_rejects_foreign_project", "FAIL", { error_code: "accepted", value_leaked: true });
    else record("snippet_rejects_foreign_project", "PASS", { error_code: null, value_leaked: false });
  } catch (error) {
    const code = errorCode(error);
    record("snippet_rejects_foreign_project", ["project_boundary", "backend_contract"].includes(code) ? "PASS" : "FAIL", { error_code: code || "unknown", value_leaked: false });
  }

  const pidFile = path.join(root, "timeout-child.pid");
  await expectError("timeout_is_reported", () => backends("hang", pidFile).cbmStatus(), "timeout");
  await new Promise((resolve) => setTimeout(resolve, 200));
  let pidObserved = false;
  let childAlive = null;
  try {
    const pid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid_pid");
    pidObserved = true;
    process.kill(pid, 0);
    childAlive = true;
  } catch (error) {
    if (error?.code === "ESRCH") childAlive = false;
    else childAlive = true;
  }
  record("timeout_child_closed", pidObserved && childAlive === false ? "PASS" : "FAIL", { pid_observed: pidObserved, child_alive: childAlive });
}

const before = await snapshot(sourceFile);
try {
  await run();
  const after = await snapshot(sourceFile);
  record("authorized_fixture_unchanged", before === after ? "PASS" : "FAIL");
  const status = checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS";
  const sourceHashes = {
    optional_backends_mjs: await snapshot(path.resolve("src/optional-backends.mjs")),
    bridge_mjs: await snapshot(path.resolve("src/bridge.mjs")),
  };
  const evidence = {
    schema_version: 1,
    generated_utc: new Date().toISOString(),
    status,
    checks,
    scope: "synthetic MCP stdio output validation only",
    authorized_fixture: { sha256_before_after_equal: before === after },
    source_sha256: sourceHashes,
    secrets_recorded: false,
  };
  await fs.mkdir(path.resolve("characterization"), { recursive: true });
  await fs.writeFile(path.resolve("characterization/backends-output-review.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  assert.equal(hasSecret(JSON.stringify(evidence)), false);
  process.stdout.write(`${JSON.stringify({ status, checks: checks.length })}\n`);
  process.exitCode = status === "PASS" ? 0 : 1;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function snapshot(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
