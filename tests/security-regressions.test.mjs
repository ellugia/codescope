import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBridge, hasSecret, normalizeConfig } from "../src/bridge.mjs";

let root;

before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "codescope-security-regressions-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("secret filtering covers credential names and common assignments without flagging prose", () => {
  for (const value of [
    "AWS_SECRET_ACCESS_KEY=synthetic-secret",
    "aws_access_key_id: 'synthetic-id'",
    '"PRIVATE_TOKEN": "synthetic-token"',
    "password = synthetic-password",
    "export OpenAI_ApiKey=synthetic-key",
    "clientSecret: synthetic-client-secret",
  ]) assert.equal(hasSecret(value), true, value);

  for (const value of [
    "The password reset instructions are public.",
    "This document explains secret rotation.",
    "A token is required to continue.",
    "api key names are discussed here without an assignment.",
  ]) assert.equal(hasSecret(value), false, value);
});

test("session fingerprints are scoped by process and normalized bridge configuration", async () => {
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await Promise.all([mkdir(repoA), mkdir(repoB)]);
  const sessionAccess = { mode: "session_select", require_session: true, ttl_seconds: 60 };
  const configA = normalizeConfig({ repositories: { repo: { root: repoA, read_only: true } }, session_access: sessionAccess });
  const configB = normalizeConfig({ repositories: { repo: { root: repoB, read_only: true } }, session_access: sessionAccess });
  const bridgeA = createBridge(configA);
  const bridgeB = createBridge(configB);
  const options = { meta: { "openai/session": "same-conversation-id" } };
  const statusA = await bridgeA.call("bridge_access_status", {}, options);
  const statusB = await bridgeB.call("bridge_access_status", {}, options);

  assert.equal(statusA.session_fingerprint.length, 16);
  assert.equal(statusB.session_fingerprint.length, 16);
  assert.notEqual(statusA.session_fingerprint, statusB.session_fingerprint);
  assert.equal(JSON.stringify(statusA).includes("same-conversation-id"), false);
  assert.equal(JSON.stringify(statusB).includes("same-conversation-id"), false);
});

test("git log keeps raw-commit pagination after redacting a commit", async () => {
  const repo = join(root, "git-log-fixture");
  await mkdir(repo);
  const config = normalizeConfig({ repositories: { fixture: { root: repo, read_only: true } } });
  const bridge = createBridge(config);
  const commits = [
    ["1".repeat(40), "2026-01-03T00:00:00+00:00", "Alice", "AWS_SECRET_ACCESS_KEY=synthetic-secret"],
    ["2".repeat(40), "2026-01-02T00:00:00+00:00", "Alice", "safe commit"],
    ["3".repeat(40), "2026-01-01T00:00:00+00:00", "Alice", "later safe commit"],
  ];
  bridge.runGit = async (_repo, args) => {
    if (args[0] === "rev-parse") return { stdout: `${commits[0][0]}\n`, stderr: "", truncated: false };
    const skip = Number(args.find((value) => value.startsWith("--skip="))?.slice(7) || 0);
    const count = Number(args.find((value) => value.startsWith("--max-count="))?.slice(12) || 0);
    return {
      stdout: commits.slice(skip, skip + count).map((record) => `${record.join("\0")}\0`).join(""),
      stderr: "",
      truncated: false,
    };
  };

  const first = await bridge.call("git_log", { repository: "fixture", max_count: 2 });
  assert.deepEqual(first.commits.map((commit) => commit.sha), [commits[1][0]]);
  assert.equal(first.redacted, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.next_cursor, "2");

  const second = await bridge.call("git_log", { repository: "fixture", max_count: 2, cursor: first.next_cursor });
  assert.deepEqual(second.commits.map((commit) => commit.sha), [commits[2][0]]);
  assert.equal(second.truncated, false);
  assert.equal(second.next_cursor, null);
});
