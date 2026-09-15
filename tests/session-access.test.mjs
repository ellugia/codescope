import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBridge, getToolDefinitions, normalizeConfig } from "../src/bridge.mjs";

let root;
let repoA;
let repoB;
let bridge;

function rawConfig(extra = {}) {
  return {
    repositories: {
      "repo-a": { root: repoA, read_only: true },
      "repo-b": { root: repoB, read_only: true },
    },
    default_repository: "repo-a",
    ...extra,
  };
}

function readArgs(repository) {
  return { repository, path: "read.txt", start_line: 1, end_line: 1, max_bytes: 256 };
}

function session(value) {
  return { meta: { "openai/session": value } };
}

function serialized(value) {
  return JSON.stringify(value);
}

function assertSafe(value, label) {
  const text = serialized(value);
  assert.doesNotMatch(text, /session-[AB]-raw/u, `${label} leaked raw session metadata`);
  assert.equal(text.includes(repoA), false, `${label} leaked repository A root`);
  assert.equal(text.includes(repoB), false, `${label} leaked repository B root`);
}

async function assertRejected(call, code, label) {
  await assert.rejects(call, (error) => {
    assert.equal(error.code, code, `${label} returned the wrong code`);
    assert.ok(error.details?.security_notice, `${label} omitted security_notice`);
    assertSafe(error, label);
    return true;
  });
}

before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "codescope-session-access-"));
  repoA = join(root, "repo-a");
  repoB = join(root, "repo-b");
  await Promise.all([
    mkdir(repoA),
    mkdir(repoB),
  ]);
  await Promise.all([
    writeFile(join(repoA, "read.txt"), "A_ONLY\n", "utf8"),
    writeFile(join(repoB, "read.txt"), "B_ONLY\n", "utf8"),
  ]);
  bridge = createBridge(normalizeConfig(rawConfig({
    session_access: { mode: "session_select", require_session: true, ttl_seconds: 60 },
  })));
  await bridge.prepare();
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("session-selected aliases gate repository reads and expire from process-local state", async () => {
  const sessionA = session("session-A-raw");

  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-a"), sessionA), "repository_access_required", "initial read");
  const initial = await bridge.call("bridge_access_status", {}, sessionA);
  assert.deepEqual(initial.authorized_aliases, []);
  assert.deepEqual(initial.configured_aliases, ["repo-a", "repo-b"]);
  assert.equal(initial.session_fingerprint.length, 16);
  assertSafe(initial, "initial status");

  const selectedA = await bridge.call("bridge_access_select", { repository: "repo-a" }, sessionA);
  assert.equal(selectedA.event, "access_granted");
  assert.deepEqual(selectedA.authorized_aliases, ["repo-a"]);
  assert.ok(selectedA.expires_at);
  assert.ok(selectedA.security_notice);
  assertSafe(selectedA, "select repo-a");

  const readA = await bridge.call("fs_read_text", readArgs("repo-a"), sessionA);
  assert.equal(readA.text, "A_ONLY\n");
  assert.ok(readA.security_notice);
  assertSafe(readA, "read repo-a");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-b"), sessionA), "repository_access_denied", "unselected repo-b");

  const selectedB = await bridge.call("bridge_access_select", { repository: "repo-b" }, sessionA);
  assert.deepEqual(selectedB.previous_authorized_aliases, ["repo-a"]);
  assert.deepEqual(selectedB.authorized_aliases, ["repo-a", "repo-b"]);
  assertSafe(selectedB, "select repo-b");

  const releasedB = await bridge.call("bridge_access_release", { repository: "repo-b" }, sessionA);
  assert.equal(releasedB.event, "access_revoked");
  assert.deepEqual(releasedB.authorized_aliases, ["repo-a"]);
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-b"), sessionA), "repository_access_denied", "released repo-b");

  const reset = await bridge.call("bridge_access_reset", {}, sessionA);
  assert.equal(reset.event, "access_reset");
  assert.deepEqual(reset.authorized_aliases, []);
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-a"), sessionA), "repository_access_required", "reset repo-a");

  const statusB = await bridge.call("bridge_access_status", {}, session("session-B-raw"));
  assert.deepEqual(statusB.authorized_aliases, []);
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-a"), session("session-B-raw")), "repository_access_required", "session B read");
  await assertRejected(() => bridge.call("bridge_access_status", {}), "session_required", "missing metadata");
});

test("session_access validation is strict while legacy config stays unrestricted", async () => {
  for (const value of [null, [], {}, { mode: "disabled", require_session: false, ttl_seconds: 60 }, { mode: "session_select", require_session: true, ttl_seconds: 59 }, { mode: "session_select", require_session: true, ttl_seconds: 86_401 }]) {
    assert.throws(() => normalizeConfig(rawConfig({ session_access: value })), (error) => error.code === "config_invalid");
  }

  const legacyConfig = normalizeConfig(rawConfig());
  assert.equal(legacyConfig.sessionAccess.mode, "disabled");
  assert.equal(getToolDefinitions(legacyConfig).some((tool) => tool.name === "bridge_access_status"), false);
  const legacyBridge = createBridge(legacyConfig);
  const read = await legacyBridge.call("fs_read_text", readArgs("repo-a"));
  assert.equal(read.text, "A_ONLY\n");
  assert.equal(read.security_notice, undefined);
});

test("Git scopes safe.directory to the canonical selected repository root", async () => {
  const repo = await bridge.repository("repo-a");
  const result = await bridge.runGit(repo, ["config", "--list", "--show-origin"], { maxBytes: 4096 });
  const entries = result.stdout.split(/\r?\n/u).filter((line) => line.includes("safe.directory="));
  assert.deepEqual(entries, [`command line:\tsafe.directory=${repo.root}`]);
});
