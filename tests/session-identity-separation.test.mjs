import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBridge, normalizeConfig } from "../src/bridge.mjs";

let root;
let repoA;
let repoB;
let config;

const sessionA = "session-A-raw-identity-separation";
const sessionB = "session-B-raw-identity-separation";

function session(raw) {
  return { meta: { "openai/session": raw } };
}

function readArgs(repository) {
  return { repository, path: "read.txt", start_line: 1, end_line: 1, max_bytes: 256 };
}

function serialized(value) {
  return `${JSON.stringify(value)} ${String(value)}`;
}

function assertSafe(value, label, forbidden = []) {
  const text = serialized(value);
  assert.equal(text.includes(sessionA), false, `${label} leaked session A`);
  assert.equal(text.includes(sessionB), false, `${label} leaked session B`);
  assert.equal(text.includes(repoA), false, `${label} leaked repository A root`);
  assert.equal(text.includes(repoB), false, `${label} leaked repository B root`);
  for (const value of forbidden) assert.equal(text.includes(String(value)), false, `${label} leaked invalid metadata`);
}

async function assertRejected(call, code, label, forbidden = []) {
  await assert.rejects(call, (error) => {
    assert.equal(error.code, code, `${label} returned the wrong code`);
    assert.ok(error.details?.security_notice, `${label} omitted security_notice`);
    assertSafe(error, label, forbidden);
    return true;
  });
}

before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "codescope-session-identity-"));
  repoA = join(root, "repo-a");
  repoB = join(root, "repo-b");
  await Promise.all([mkdir(repoA), mkdir(repoB)]);
  await Promise.all([
    writeFile(join(repoA, "read.txt"), "A_ONLY\n", "utf8"),
    writeFile(join(repoB, "read.txt"), "B_ONLY\n", "utf8"),
  ]);
  config = normalizeConfig({
    repositories: {
      "repo-a": { root: repoA, read_only: true },
      "repo-b": { root: repoB, read_only: true },
    },
    default_repository: "repo-a",
    session_access: { mode: "session_select", require_session: true, ttl_seconds: 60 },
  });
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("session identity and bridge instance state stay separated", async () => {
  const bridge = createBridge(config);
  await bridge.prepare();

  const initial = await bridge.call("bridge_access_status", {}, session(sessionA));
  assert.deepEqual(initial.authorized_aliases, []);
  assert.deepEqual(initial.configured_aliases, ["repo-a", "repo-b"]);
  assertSafe(initial, "initial status");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-a"), session(sessionA)), "repository_access_required", "initial read");

  const selectedA = await bridge.call("bridge_access_select", { repository: "repo-a" }, session(sessionA));
  assert.deepEqual(selectedA.authorized_aliases, ["repo-a"]);
  assertSafe(selectedA, "select repo-a");
  const readA = await bridge.call("fs_read_text", readArgs("repo-a"), session(sessionA));
  assert.equal(readA.text, "A_ONLY\n");
  assertSafe(readA, "read repo-a");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-b"), session(sessionA)), "repository_access_denied", "repo-b before selection");

  const freshBridge = createBridge(config);
  await freshBridge.prepare();
  const freshStatus = await freshBridge.call("bridge_access_status", {}, session(sessionA));
  assert.deepEqual(freshStatus.authorized_aliases, []);
  assertSafe(freshStatus, "fresh bridge status");
  await assertRejected(() => freshBridge.call("fs_read_text", readArgs("repo-a"), session(sessionA)), "repository_access_required", "fresh bridge read");

  const selectedB = await bridge.call("bridge_access_select", { repository: "repo-b" }, session(sessionA));
  assert.deepEqual(selectedB.previous_authorized_aliases, ["repo-a"]);
  assert.deepEqual(selectedB.authorized_aliases, ["repo-a", "repo-b"]);
  assertSafe(selectedB, "select repo-b");
  const readAAfterSelection = await bridge.call("fs_read_text", readArgs("repo-a"), session(sessionA));
  const readBAfterSelection = await bridge.call("fs_read_text", readArgs("repo-b"), session(sessionA));
  assert.equal(readAAfterSelection.text, "A_ONLY\n");
  assert.equal(readBAfterSelection.text, "B_ONLY\n");
  assertSafe(readAAfterSelection, "read selected repo-a");
  assertSafe(readBAfterSelection, "read selected repo-b");

  const statusB = await bridge.call("bridge_access_status", {}, session(sessionB));
  assert.deepEqual(statusB.authorized_aliases, []);
  assertSafe(statusB, "session B status");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-a"), session(sessionB)), "repository_access_required", "session B repo-a read");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-b"), session(sessionB)), "repository_access_required", "session B repo-b read");

  const releasedB = await bridge.call("bridge_access_release", { repository: "repo-b" }, session(sessionA));
  assert.deepEqual(releasedB.authorized_aliases, ["repo-a"]);
  assertSafe(releasedB, "release repo-b");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-b"), session(sessionA)), "repository_access_denied", "repo-b after release");

  const reset = await bridge.call("bridge_access_reset", {}, session(sessionA));
  assert.deepEqual(reset.authorized_aliases, []);
  assertSafe(reset, "reset session A");
  const finalStatus = await bridge.call("bridge_access_status", {}, session(sessionA));
  assert.deepEqual(finalStatus.authorized_aliases, []);
  assertSafe(finalStatus, "final status");
  await assertRejected(() => bridge.call("fs_read_text", readArgs("repo-a"), session(sessionA)), "repository_access_required", "repo-a after reset");

  await assertRejected(() => bridge.call("bridge_access_status", {}), "session_required", "missing session metadata");
  const nonStringSession = 12345;
  await assertRejected(
    () => bridge.call("bridge_access_status", {}, { meta: { "openai/session": nonStringSession } }),
    "session_required",
    "non-string session metadata",
    [nonStringSession],
  );
  const oversizedSession = "oversized-session-".padEnd(4_097, "x");
  assert.equal(oversizedSession.length, 4_097);
  await assertRejected(
    () => bridge.call("bridge_access_status", {}, { meta: { "openai/session": oversizedSession } }),
    "session_required",
    "oversized session metadata",
    [oversizedSession],
  );

  const ttlBridge = createBridge(config);
  await ttlBridge.prepare();
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    const selectedBeforeExpiry = await ttlBridge.call("bridge_access_select", { repository: "repo-a" }, session(sessionA));
    assert.deepEqual(selectedBeforeExpiry.authorized_aliases, ["repo-a"]);
    assertSafe(selectedBeforeExpiry, "TTL selection");
    now += config.sessionAccess.ttlSeconds * 1_000 + 1;
    const expiredStatus = await ttlBridge.call("bridge_access_status", {}, session(sessionA));
    assert.deepEqual(expiredStatus.authorized_aliases, []);
    assertSafe(expiredStatus, "expired session status");
  } finally {
    Date.now = originalNow;
  }
});
