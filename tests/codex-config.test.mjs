import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnFile } from "./test-process.mjs";
import {
  CODEX_CONFIG_LIMITS,
  discoverCodexRepositories,
  parseCodexProjectPaths,
  resolveCodexConfigPath,
} from "../src/codex-config.mjs";

const cli = path.join(process.cwd(), "bin", "codescope.mjs");

async function tempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "codescope-codex-config-"));
}

async function writeConfig(codexHome, contents) {
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), contents, "utf8");
}

test("reads repositories from an explicit CODEX_HOME", async () => {
  const root = await tempRoot();
  try {
    const codexHome = path.join(root, "explicit-codex-home");
    const repository = path.join(root, "repository-a");
    await writeConfig(codexHome, `[projects.'${repository}']\ntrust_level = "trusted"\n`);

    const result = await discoverCodexRepositories({ environment: { CODEX_HOME: codexHome }, homeDirectory: path.join(root, "unused-home") });
    assert.equal(result.config_path, resolveCodexConfigPath({ CODEX_HOME: codexHome }));
    assert.deepEqual(result.candidates, [{ path: repository, authorized: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI codex-repositories emits stable JSON and text candidates", async () => {
  const root = await tempRoot();
  try {
    const codexHome = path.join(root, "codex-home");
    const repository = path.join(root, "repository-cli");
    await writeConfig(codexHome, `[projects.'${repository}']\n`);
    const environment = { ...process.env, CODEX_HOME: codexHome };

    const json = await spawnFile(process.execPath, [cli, "codex-repositories"], { env: environment });
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), {
      codex_home: codexHome,
      config_path: path.join(codexHome, "config.toml"),
      config_exists: true,
      candidates: [{ path: repository, authorized: false }],
    });

    const text = await spawnFile(process.execPath, [cli, "codex-repositories", "--text"], { env: environment });
    assert.equal(text.status, 0);
    assert.equal(text.stdout, `${repository}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to .codex below the supplied home directory", async () => {
  const root = await tempRoot();
  try {
    const homeDirectory = path.join(root, "home");
    const repository = path.join(root, "repository-b");
    await writeConfig(path.join(homeDirectory, ".codex"), `[projects."${repository.replaceAll("\\", "\\\\")}"]\n`);

    const result = await discoverCodexRepositories({ environment: {}, homeDirectory });
    assert.equal(result.codex_home, path.join(homeDirectory, ".codex"));
    assert.deepEqual(result.candidates, [{ path: repository, authorized: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts both project key quote styles and deduplicates paths", () => {
  const repository = path.join(os.tmpdir(), "codescope-synthetic-repository");
  const contents = [
    `[projects.'${repository}']`,
    `[projects."${repository.replaceAll("\\", "\\\\")}"]`,
    "[projects.'relative-repository']",
    "[unrelated]",
  ].join("\n");

  assert.deepEqual(parseCodexProjectPaths(contents), [repository]);
});

test("decodes Unicode paths and skips malformed or unsafe project sections", () => {
  const repository = path.resolve(os.tmpdir(), "codescope-unicode-ñ");
  const encoded = JSON.stringify(repository).replace("ñ", "\\u00f1");
  const contents = [
    `[projects.${encoded}]`,
    `[projects."${repository.replaceAll("\\", "\\\\")}\\q"]`,
    `[projects."${repository.replaceAll("\\", "\\\\")}\\u001b"]`,
  ].join("\n");

  assert.deepEqual(parseCodexProjectPaths(contents), [repository]);
});

test("bounds CODEX_HOME/config.toml before parsing it", async () => {
  const root = await tempRoot();
  try {
    const codexHome = path.join(root, "codex-home");
    await writeConfig(codexHome, "#".repeat(CODEX_CONFIG_LIMITS.maxBytes + 1));
    const result = await discoverCodexRepositories({ environment: { CODEX_HOME: codexHome } });
    assert.equal(result.error.code, "config_too_large");
    assert.deepEqual(result.candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function isolatedUserConfigEnvironment(root) {
  const environment = { ...process.env };
  delete environment.CODESCOPE_CONFIG;
  if (process.platform === "win32") environment.APPDATA = path.join(root, "appdata");
  else if (process.platform === "darwin") environment.HOME = path.join(root, "home");
  else environment.XDG_CONFIG_HOME = path.join(root, "xdg");
  return environment;
}

test("CLI config precedence is --config, then CODESCOPE_CONFIG, then the user default", async () => {
  const root = await tempRoot();
  try {
    const environmentConfig = path.join(root, "from-environment.json");
    const flagConfig = path.join(root, "from-flag.json");
    const environment = { ...process.env, CODESCOPE_CONFIG: environmentConfig };
    const withoutConfig = isolatedUserConfigEnvironment(root);

    const fromEnvironment = await spawnFile(process.execPath, [cli, "init"], { env: environment });
    assert.equal(fromEnvironment.status, 0);
    await access(environmentConfig);

    const fromFlag = await spawnFile(process.execPath, [cli, "init", "--config", flagConfig], { env: environment });
    assert.equal(fromFlag.status, 0);
    await access(flagConfig);

    const fromDefault = await spawnFile(process.execPath, [cli, "init"], { cwd: root, env: withoutConfig });
    assert.equal(fromDefault.status, 0);
    const defaultConfig = process.platform === "win32"
      ? path.join(root, "appdata", "CodeScope", "config.json")
      : process.platform === "darwin"
        ? path.join(root, "home", "Library", "Application Support", "CodeScope", "config.json")
        : path.join(root, "xdg", "codescope", "config.json");
    await access(defaultConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
