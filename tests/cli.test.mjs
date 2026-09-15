import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnFile } from "./test-process.mjs";

const cli = join(process.cwd(), "bin", "codescope.mjs");

test("CLI exposes help and version without starting a server", async () => {
  const help = await spawnFile(process.execPath, [cli, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /codescope serve/);
  assert.match(help.stdout, /codescope setup/);
  assert.match(help.stdout, /codescope instructions/);

  const version = await spawnFile(process.execPath, [cli, "--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "0.1.1");
});

test("CLI prints the portable ChatGPT Project instructions", async () => {
  const result = await spawnFile(process.execPath, [cli, "instructions"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^# CodeScope project instructions/);
  assert.match(result.stdout, /user-facing conversation in the user's language/);
  assert.doesNotMatch(result.stdout, /D:\\codex|C:\\Users\\/i);
});

test("setup creates the default user configuration without requiring a TTY", async () => {
  const root = await mkdtemp(join(process.cwd(), "tests", "tmp-setup-"));
  try {
    const environment = { ...process.env };
    delete environment.CODESCOPE_CONFIG;
    if (process.platform === "win32") environment.APPDATA = join(root, "appdata");
    else if (process.platform === "darwin") environment.HOME = join(root, "home");
    else environment.XDG_CONFIG_HOME = join(root, "xdg");
    const result = await spawnFile(process.execPath, [cli, "setup"], { cwd: root, env: environment });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /local configuration/i);
    assert.match(result.stdout, /interactive terminal/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init creates a local template and refuses accidental overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "codescope-cli-"));
  const config = join(root, "config.json");
  const created = await spawnFile(process.execPath, [cli, "init", "--config", config]);
  assert.equal(created.status, 0);
  assert.match(await readFile(config, "utf8"), /\"read_only\": true/);
  assert.match(created.stdout, /codescope\.mjs.*instructions/);

  const refused = await spawnFile(process.execPath, [cli, "init", "--config", config]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
});
