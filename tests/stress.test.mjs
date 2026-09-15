import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createBridge,
  loadConfig,
  normalizeConfig,
  toSafeError,
} from "../src/bridge.mjs";
import {
  activeAliases,
  readUiConfig,
  setDefaultRepository,
  setRepositoryEnabled,
  writeUiConfig,
} from "../src/tui.mjs";

const ITERATIONS = 20;
const startedAt = process.hrtime.bigint();
let completedIterations = 0;

function muteBridgeAudit() {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    const actualEncoding = typeof encoding === "string" ? encoding : undefined;
    const done = typeof encoding === "function" ? encoding : callback;
    const text = Buffer.isBuffer(chunk) ? chunk.toString(actualEncoding) : String(chunk);
    if (text.includes('"event":"bridge_call"')) {
      if (typeof done === "function") done();
      return true;
    }
    return originalWrite(chunk, actualEncoding, done);
  };
  return () => {
    process.stderr.write = originalWrite;
  };
}

process.on("exit", () => {
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  const status = (process.exitCode ?? 0) === 0 ? "PASS" : "FAIL";
  process.stderr.write(`STRESS_SUMMARY ${JSON.stringify({ status, iterations: completedIterations, elapsed_ms: elapsedMs })}\n`);
});

function session() {
  return { meta: { "openai/session": "codescope-stress-session" } };
}

function errorCode(error) {
  return toSafeError(error).code;
}

function configFor(alpha, beta) {
  return {
    default_repository: "alpha",
    repositories: {
      alpha: { root: alpha, read_only: true },
      beta: { root: beta, read_only: true },
    },
    limits: {
      max_response_bytes: 8_192,
      max_file_bytes: 64 * 1024,
      max_entries: 8,
      max_lines: 2_000,
    },
    session_access: { mode: "session_select", require_session: true, ttl_seconds: 60 },
  };
}

async function readAllPages(bridge, repository, expectedLines, expectedText) {
  const chunks = [];
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const args = {
      repository,
      path: "paged.txt",
      end_line: expectedLines,
      max_bytes: 70,
      ...(cursor ? { cursor } : { start_line: 1 }),
    };
    const result = await bridge.call("fs_read_text", args, session());
    chunks.push(result.text);
    if (!result.truncated) {
      assert.equal(result.next_cursor, null);
      assert.equal(chunks.join(""), expectedText);
      return;
    }
    assert.equal(typeof result.next_cursor, "string");
    cursor = result.next_cursor;
  }
  assert.fail("read pagination did not reach EOF within 100 pages");
}

async function listAllPages(bridge, repository, expectedPaths) {
  const paths = [];
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const result = await bridge.call("fs_list", {
      repository,
      path: "",
      max_entries: 2,
      ...(cursor ? { cursor } : {}),
    }, session());
    paths.push(...result.entries.map((entry) => entry.path));
    if (!result.truncated) {
      assert.equal(result.next_cursor, null);
      assert.deepEqual(paths, expectedPaths);
      return;
    }
    assert.equal(typeof result.next_cursor, "string");
    cursor = result.next_cursor;
  }
  assert.fail("list pagination did not reach EOF within 100 pages");
}

async function assertRejected(bridge, name, args, code) {
  await assert.rejects(
    bridge.call(name, args, session()),
    (error) => errorCode(error) === code,
    `${name} should reject with ${code}`,
  );
}

test("bounded stress loop keeps persisted allowlists, sessions, cursors, and cleanup deterministic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codescope-stress-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  const configPath = path.join(root, "config.json");
  const lines = Array.from({ length: 32 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}: á😀${"x".repeat(18)}\n`);
  const expectedText = lines.join("");
  const expectedPaths = [
    "alpha-01.txt",
    "alpha-02.txt",
    "alpha-03.txt",
    "alpha-04.txt",
    "alpha-05.txt",
    "paged.txt",
  ];

  try {
    await Promise.all([
      mkdir(alpha, { recursive: true }),
      mkdir(beta, { recursive: true }),
    ]);
    await writeFile(path.join(alpha, "paged.txt"), expectedText, "utf8");
    await Promise.all(expectedPaths.slice(0, 5).map((name) => writeFile(path.join(alpha, name), `${name}\n`, "utf8")));
    await writeFile(path.join(alpha, ".env"), "TOKEN=synthetic-stress-value\n", "utf8");
    await writeFile(path.join(beta, "beta.txt"), "synthetic beta\n", "utf8");

    const initial = configFor(alpha, beta);
    initial.repositories.gamma = { root: path.join(root, "gamma"), read_only: true, enabled: false };
    await writeUiConfig(configPath, initial);

    const invalidReadOnly = configFor(alpha, beta);
    invalidReadOnly.repositories.alpha.read_only = false;
    assert.throws(() => normalizeConfig(invalidReadOnly), (error) => errorCode(error) === "config_invalid");
    const invalidLimits = configFor(alpha, beta);
    invalidLimits.limits.max_entries = 0;
    assert.throws(() => normalizeConfig(invalidLimits), (error) => errorCode(error) === "config_invalid");
    const invalidSession = configFor(alpha, beta);
    invalidSession.session_access.ttl_seconds = 1;
    assert.throws(() => normalizeConfig(invalidSession), (error) => errorCode(error) === "config_invalid");

    const restoreAudit = muteBridgeAudit();
    try {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const persisted = await readUiConfig(configPath);
      const betaEnabled = iteration % 3 !== 1;
      setRepositoryEnabled(persisted, "beta", betaEnabled);
      setDefaultRepository(persisted, betaEnabled ? "beta" : "alpha");
      await writeUiConfig(configPath, persisted);

      const reloaded = await readUiConfig(configPath);
      assert.deepEqual(reloaded, persisted);
      assert.deepEqual(activeAliases(reloaded), betaEnabled ? ["alpha", "beta"] : ["alpha"]);

      const normalized = await loadConfig(configPath);
      const normalizedAgain = await loadConfig(configPath);
      assert.deepEqual(normalizedAgain, normalized);
      assert.deepEqual(Object.keys(normalized.repositories).sort(), betaEnabled ? ["alpha", "beta"] : ["alpha"]);
      assert.equal(normalized.defaultRepository, betaEnabled ? "beta" : "alpha");

      const bridge = createBridge(normalized);
      await bridge.prepare();
      await assertRejected(bridge, "fs_read_text", { repository: "alpha", path: "paged.txt", start_line: 1, end_line: 1, max_bytes: 70 }, "repository_access_required");
      const status = await bridge.call("bridge_access_status", {}, session());
      assert.deepEqual(status.authorized_aliases, []);

      if (betaEnabled) {
        const alphaSession = { meta: { "openai/session": `codescope-stress-alpha-${iteration}` } };
        const betaSession = { meta: { "openai/session": `codescope-stress-beta-${iteration}` } };
        const selections = await Promise.allSettled([
          bridge.call("bridge_access_select", { repository: "alpha" }, alphaSession),
          bridge.call("bridge_access_select", { repository: "beta" }, betaSession),
        ]);
        assert.equal(selections.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(selections.filter((result) => result.status === "rejected").length, 1);
        const rejectedSelection = selections.find((result) => result.status === "rejected");
        assert.equal(errorCode(rejectedSelection.reason), "concurrency_limit");
        const winner = selections.findIndex((result) => result.status === "fulfilled");
        const winnerSession = winner === 0 ? alphaSession : betaSession;
        const winnerRepository = winner === 0 ? "alpha" : "beta";
        const winnerRead = await bridge.call("fs_read_text", {
          repository: winnerRepository,
          path: winner === 0 ? "paged.txt" : "beta.txt",
          start_line: 1,
          end_line: 1,
          max_bytes: 70,
        }, winnerSession);
        if (winner === 0) assert.match(winnerRead.text, /^line-01:/u);
        else assert.equal(winnerRead.text, "synthetic beta\n");
        const loser = winner === 0 ? 1 : 0;
        const loserSession = loser === 0 ? alphaSession : betaSession;
        const loserRepository = loser === 0 ? "alpha" : "beta";
        const loserSelection = await bridge.call("bridge_access_select", { repository: loserRepository }, loserSession);
        assert.deepEqual(loserSelection.authorized_aliases, [loserRepository]);
        const loserRead = await bridge.call("fs_read_text", {
          repository: loserRepository,
          path: loser === 0 ? "paged.txt" : "beta.txt",
          start_line: 1,
          end_line: 1,
          max_bytes: 70,
        }, loserSession);
        if (loser === 0) assert.match(loserRead.text, /^line-01:/u);
        else assert.equal(loserRead.text, "synthetic beta\n");
      }

      const selectedAlpha = await bridge.call("bridge_access_select", { repository: "alpha" }, session());
      assert.deepEqual(selectedAlpha.authorized_aliases, ["alpha"]);
      await readAllPages(bridge, "alpha", lines.length, expectedText);
      await listAllPages(bridge, "alpha", expectedPaths);

      await assertRejected(bridge, "fs_read_text", { repository: "beta", path: "beta.txt", start_line: 1, end_line: 1, max_bytes: 70 }, betaEnabled ? "repository_access_denied" : "repository_denied");
      await assertRejected(bridge, "fs_list", { repository: "alpha", path: "", max_entries: 2, cursor: "bad-cursor" }, "invalid_arguments");
      await assertRejected(bridge, "fs_read_text", { repository: "alpha", path: "paged.txt", start_line: 1, end_line: 1, max_bytes: 70, cursor: "bad-cursor" }, "invalid_arguments");
      await assertRejected(bridge, "fs_read_text", { repository: "alpha", path: "../outside.txt", start_line: 1, end_line: 1, max_bytes: 70 }, "path_denied");
      await assertRejected(bridge, "fs_read_text", { repository: "alpha", path: ".env", start_line: 1, end_line: 1, max_bytes: 70 }, "secret_denied");
      await assertRejected(bridge, "fs_list", { repository: "alpha", path: "", max_entries: 0 }, "invalid_arguments");
      await assertRejected(bridge, "fs_list", { repository: "alpha", path: "", max_entries: 2, extra: true }, "invalid_arguments");

      if (betaEnabled) {
        const selectedBeta = await bridge.call("bridge_access_select", { repository: "beta" }, session());
        assert.deepEqual(selectedBeta.authorized_aliases, ["alpha", "beta"]);
        const betaRead = await bridge.call("fs_read_text", { repository: "beta", path: "beta.txt", start_line: 1, end_line: 1, max_bytes: 70 }, session());
        assert.equal(betaRead.text, "synthetic beta\n");
        const released = await bridge.call("bridge_access_release", { repository: "alpha" }, session());
        assert.deepEqual(released.authorized_aliases, ["beta"]);
        await assertRejected(bridge, "fs_read_text", { repository: "alpha", path: "paged.txt", start_line: 1, end_line: 1, max_bytes: 70 }, "repository_access_denied");
      } else {
        await assertRejected(bridge, "bridge_access_select", { repository: "beta" }, "repository_denied");
      }

      const reset = await bridge.call("bridge_access_reset", {}, session());
      assert.deepEqual(reset.authorized_aliases, []);
      completedIterations = iteration + 1;
    }
    } finally {
      restoreAudit();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
