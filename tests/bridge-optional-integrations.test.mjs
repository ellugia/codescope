import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridge, getToolDefinitions, loadConfig, normalizeConfig, toSafeError } from "../src/bridge.mjs";

async function makeRoot() {
  return await mkdtemp(path.join(await realpath(os.tmpdir()), "codescope-bridge-optional-"));
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("design guidance is universal while Ponytail is advertised only after validated discovery", async () => {
  const root = await makeRoot();
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const basePath = path.join(root, "codex-home");
  const localAppData = path.join(root, "local-app-data");
  const appData = path.join(root, "app-data");
  const ponytail = path.join(basePath, "plugins", "cache", "ponytail", "ponytail", "4.9.0");
  const mcp = path.join(ponytail, "ponytail-mcp");
  await mkdir(path.join(ponytail, ".codex-plugin"), { recursive: true });
  await mkdir(mcp, { recursive: true });
  await writeFile(path.join(ponytail, ".codex-plugin", "plugin.json"), "{}", "utf8");
  await writeFile(path.join(ponytail, "package.json"), JSON.stringify({ version: "4.9.0" }), "utf8");
  await writeFile(path.join(mcp, "package.json"), JSON.stringify({ name: "ponytail-mcp", type: "module" }), "utf8");
  await writeFile(path.join(mcp, "index.js"), "// marker\n", "utf8");
  await writeFile(path.join(mcp, "instructions.js"), "export function resolveMode(mode) { return mode || 'full'; }\nexport function buildInstructions(mode) { return `synthetic Ponytail ${mode}`; }\n", "utf8");

  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
  };
  process.env.CODEX_HOME = basePath;
  process.env.LOCALAPPDATA = localAppData;
  process.env.APPDATA = appData;
  try {
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      repositories: { demo: { root: repo, read_only: true } },
      optional_backends: { auto_discover: true },
    }), "utf8");
    const config = await loadConfig(configPath);
    const names = getToolDefinitions(config).map((tool) => tool.name);
    assert.ok(names.includes("design_guidance"));
    assert.ok(names.includes("ponytail_instructions"));
    assert.equal(config.optionalBackends.discovery.integrations.ponytail.status, "validated");

    const bridge = createBridge(config);
    const guidance = await bridge.call("design_guidance", { theme: "security" });
    assert.equal(guidance.theme, "security");
    assert.equal(guidance.provenance.advisory, true);
    assert.match(guidance.security_notice, /advisory/u);

    const ponytailResult = await bridge.call("ponytail_instructions", { mode: "lite" });
    assert.equal(ponytailResult.backend, "ponytail");
    assert.equal(ponytailResult.mode, "lite");
    assert.equal(ponytailResult.instructions, "synthetic Ponytail lite");

    await assert.rejects(
      bridge.call("design_guidance", { theme: "unknown" }),
      (error) => error.code === "invalid_arguments",
    );
  } finally {
    restoreEnvironment(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("base configuration keeps universal filesystem/Git and hides optional integrations", async () => {
  const root = await makeRoot();
  try {
    const config = normalizeConfig({ repositories: { demo: { root, read_only: true } } });
    const names = getToolDefinitions(config).map((tool) => tool.name);
    assert.ok(names.includes("fs_read_text"));
    assert.ok(names.includes("git_status"));
    assert.ok(names.includes("design_guidance"));
    assert.equal(names.includes("ponytail_instructions"), false);
    assert.equal(names.includes("cbm_status"), false);
    assert.equal(names.includes("context_mode_search"), false);
    const bridge = createBridge(config);
    await assert.rejects(
      bridge.call("ponytail_instructions", { mode: "full" }),
      (error) => toSafeError(error).code === "tool_denied",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
