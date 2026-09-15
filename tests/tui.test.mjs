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
  setRepositoryEnabled,
  writeUiConfig,
} from "../src/tui.mjs";
import { normalizeConfig } from "../src/bridge.mjs";

test("TUI key decoder and alias generation stay deterministic", () => {
  assert.equal(decodeKey("\u001b[A"), "up");
  assert.equal(decodeKey("\u001b[B"), "down");
  assert.equal(decodeKey("\r"), "select");
  assert.equal(decodeKey("q"), "back");
  assert.equal(aliasForPath("/work/My Repo"), "my-repo");
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
  await addRepository(config, join(root, "third"), "third").catch((error) => assert.match(error.message, /no existe/));
  setRepositoryEnabled(config, "second", false);
  assert.deepEqual(activeAliases(config), ["first"]);
  await writeUiConfig(configPath, config);
  assert.match(await readFile(configPath, "utf8"), /"read_only": true/);
  const normalized = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  assert.deepEqual(Object.keys(normalized.repositories), ["first"]);
  removeRepository(config, "second");
  assert.equal(config.repositories.second, undefined);
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
