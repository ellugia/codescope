import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeAliases,
  addRepository,
  aliasForPath,
  decodeKey,
  removeRepository,
  renderMenu,
  setOptionalBackendEnabled,
  setRepositoryEnabled,
  writeUiConfig,
} from "../src/tui.mjs";
import { normalizeConfig } from "../src/bridge.mjs";

test("TUI key decoder and alias generation stay deterministic", () => {
  assert.equal(decodeKey("\u001b[A"), "up");
  assert.equal(decodeKey("\u001b[B"), "down");
  assert.equal(decodeKey("\u001bOA"), "up");
  assert.equal(decodeKey("\u001bOB"), "down");
  assert.equal(decodeKey("k"), "up");
  assert.equal(decodeKey("j"), "down");
  assert.equal(decodeKey("\r"), "select");
  assert.equal(decodeKey("q"), "back");
  assert.equal(aliasForPath("/work/My Repo"), "my-repo");
});

test("TUI rendering exposes hierarchy, status, selection, and keyboard help", () => {
  const output = renderMenu("Local configuration", ["First", "Second"], 1, "Repository removed.");
  assert.match(output, /CodeScope/u);
  assert.match(output, /Local read-only bridge configuration/u);
  assert.match(output, /Status · Repository removed\./u);
  assert.match(output, /\u001b\[36m❯\u001b\[0m \u001b\[1mSecond\u001b\[0m/u);
  assert.match(output, /↑\/↓ or j\/k Move · Enter Select · Esc\/q Back · Ctrl\+C Quit/u);
});

test("TUI repository changes persist read-only entries and leave one active repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "codescope-tui-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const configPath = join(root, "config.json");
  const fs = await import("node:fs/promises");
  await fs.mkdir(first);
  await fs.mkdir(second);
  const config = { default_repository: "first", repositories: { first: { root: first, read_only: true }, second: { root: second, read_only: true } } };
  await addRepository(config, join(root, "third"), "third").catch((error) => assert.match(error.message, /does not exist/u));
  setRepositoryEnabled(config, "second", false);
  assert.deepEqual(activeAliases(config), ["first"]);
  await writeUiConfig(configPath, config);
  assert.match(await readFile(configPath, "utf8"), /"read_only": true/);
  const normalized = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  assert.deepEqual(Object.keys(normalized.repositories), ["first"]);
  removeRepository(config, "second");
  assert.equal(config.repositories.second, undefined);

  const defaultFallback = { default_repository: "first", repositories: {
    first: { root: first, read_only: true },
    second: { root: second, read_only: true },
  } };
  setRepositoryEnabled(defaultFallback, "first", false);
  assert.equal(defaultFallback.default_repository, "second");
});

test("TUI overwrites saved state on a second write and toggles legacy optional bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "codescope-tui-state-"));
  const configPath = join(root, "config.json");
  const config = {
    optional_backends: {
      codebase_memory: { enabled: false },
      context_mode: { enabled: false },
    },
  };
  await writeUiConfig(configPath, { version: 1 });
  await writeUiConfig(configPath, config);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), config);
  setOptionalBackendEnabled(config, "fixture", "codebase_memory", true);
  setOptionalBackendEnabled(config, "fixture", "context_mode", true);
  assert.equal(config.optional_backends.codebase_memory.enabled, true);
  assert.equal(config.optional_backends.context_mode.enabled, true);
});

test("bridge rejects a configuration with every repository disabled", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  assert.throws(() => normalizeConfig({
    repositories: { only: { root, read_only: true, enabled: false } },
  }), (error) => error.code === "config_invalid");
});

test("a disabled optional binding remains editable without advertising a tool", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  const config = normalizeConfig({
    repositories: { repo: { root, read_only: true } },
    optional_backends: {
      bindings: { repo: { read_only: true, codebase_memory: { enabled: false, read_only: true } } },
    },
  });
  assert.equal(config.optionalBackends.bindings.repo.codebaseMemory, null);
});
