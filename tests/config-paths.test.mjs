import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfigPath, userConfigDirectory, userConfigPath } from "../src/config-paths.mjs";

async function tempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "codescope-config-paths-"));
}

test("uses platform-specific user configuration directories", () => {
  const home = "C:\\Users\\test-user";
  assert.equal(userConfigDirectory({ platform: "win32", env: {}, homeDirectory: home }), "C:\\Users\\test-user\\AppData\\Roaming\\CodeScope");
  assert.equal(userConfigDirectory({ platform: "darwin", env: {}, homeDirectory: "/Users/test-user" }), "/Users/test-user/Library/Application Support/CodeScope");
  assert.equal(userConfigDirectory({ platform: "linux", env: {}, homeDirectory: "/home/test-user" }), "/home/test-user/.config/codescope");
  assert.equal(userConfigDirectory({ platform: "linux", env: { XDG_CONFIG_HOME: "/tmp/config" }, homeDirectory: "/home/test-user" }), "/tmp/config/codescope");
});

test("keeps explicit and environment configuration paths ahead of defaults", () => {
  const root = path.resolve("workspace");
  const options = { cwd: root, platform: process.platform, homeDirectory: path.resolve("home"), exists: () => false };
  assert.equal(resolveConfigPath({ ...options, explicitPath: "./chosen.json", env: {} }), path.resolve(root, "chosen.json"));
  assert.equal(resolveConfigPath({ ...options, env: { CODESCOPE_CONFIG: "./from-env.json" } }), path.resolve(root, "from-env.json"));
});

test("prefers an existing user config and retains an existing cwd config for compatibility", async () => {
  const root = await tempRoot();
  try {
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const options = { platform: process.platform, env: {}, homeDirectory: home, cwd };
    const userPath = userConfigPath(options);
    const legacyPath = path.join(cwd, "config.json");

    assert.equal(resolveConfigPath(options), userPath);
    await mkdir(path.dirname(userPath), { recursive: true });
    await writeFile(userPath, "{}", "utf8");
    assert.equal(resolveConfigPath(options), userPath);

    await rm(userPath);
    await writeFile(legacyPath, "{}", "utf8");
    assert.equal(resolveConfigPath(options), legacyPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
