import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnFile } from "./test-process.mjs";

const cli = join(process.cwd(), "bin", "codescope.mjs");

test("CLI exposes help and version without starting a server", async () => {
  const help = await spawnFile(process.execPath, [cli, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /codescope serve/);

  const version = await spawnFile(process.execPath, [cli, "--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "0.1.0");
});

test("CLI init creates a local template and refuses accidental overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "codescope-cli-"));
  const config = join(root, "config.json");
  const created = await spawnFile(process.execPath, [cli, "init", "--config", config]);
  assert.equal(created.status, 0);
  assert.match(await readFile(config, "utf8"), /\"read_only\": true/);

  const refused = await spawnFile(process.execPath, [cli, "init", "--config", config]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
});
