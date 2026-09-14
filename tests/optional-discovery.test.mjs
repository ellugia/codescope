import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverOptionalIntegrations } from "../src/optional-discovery.mjs";

async function tempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "codescope-discovery-"));
}

function roots(root) {
  return {
    basePath: path.join(root, "codex-home"),
    localAppData: path.join(root, "local-app-data"),
    appData: path.join(root, "app-data"),
  };
}

test("detects synthetic installations without launching or reading them", async () => {
  const root = await tempRoot();
  try {
    const environment = roots(root);
    const ponytailMarker = path.join(environment.basePath, "plugins", "cache", "ponytail", "ponytail", "4.9.0", ".codex-plugin", "plugin.json");
    await mkdir(path.dirname(ponytailMarker), { recursive: true });
    await writeFile(ponytailMarker, "{}", "utf8");
    await mkdir(path.dirname(path.join(environment.localAppData, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe")), { recursive: true });
    await writeFile(path.join(environment.localAppData, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe"), "synthetic", "utf8");
    await mkdir(path.dirname(path.join(environment.appData, "npm", "node_modules", "context-mode", "server.bundle.mjs")), { recursive: true });
    await writeFile(path.join(environment.appData, "npm", "node_modules", "context-mode", "server.bundle.mjs"), "synthetic", "utf8");

    const discovered = discoverOptionalIntegrations({ enabled: true }, environment);
    assert.deepEqual(Object.fromEntries(Object.entries(discovered.integrations).map(([name, value]) => [name, value.status])), {
      ponytail: "validated",
      codebase_memory: "validated",
      context_mode: "validated",
    });
    assert.equal(discovered.integrations.ponytail.version, "4.9.0");
    assert.equal(discovered.policy.filesystem, "universal");
    assert.equal(discovered.policy.git, "universal");
    assert.equal(discovered.policy.optional, "opt_in");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports absent when valid roots contain no known installation", async () => {
  const root = await tempRoot();
  try {
    const discovered = discoverOptionalIntegrations({ enabled: true }, roots(root));
    for (const integration of Object.values(discovered.integrations)) assert.equal(integration.status, "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports found separately when a known Ponytail root lacks its marker", async () => {
  const root = await tempRoot();
  try {
    const environment = roots(root);
    await mkdir(path.join(environment.basePath, "plugins", "cache", "ponytail", "ponytail", "4.9.0"), { recursive: true });
    const discovered = discoverOptionalIntegrations({ enabled: true }, environment);
    assert.equal(discovered.integrations.ponytail.status, "found");
    assert.equal(discovered.integrations.ponytail.validated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports unavailable for invalid roots", async () => {
  const discovered = discoverOptionalIntegrations({ enabled: true }, {
    basePath: "relative-codex-home",
    localAppData: "relative-local-app-data",
    appData: "relative-app-data",
  });
  for (const integration of Object.values(discovered.integrations)) {
    assert.equal(integration.status, "unavailable");
    assert.equal(integration.reason, "invalid_root");
  }
});

test("does not inspect anything when autodiscovery is disabled", () => {
  const discovered = discoverOptionalIntegrations({ enabled: false }, {
    basePath: "invalid",
    localAppData: "invalid",
    appData: "invalid",
    fs: {
      lstatSync: () => { throw new Error("filesystem access should be skipped"); },
      realpathSync: () => { throw new Error("filesystem access should be skipped"); },
      readdirSync: () => { throw new Error("filesystem access should be skipped"); },
    },
  });
  assert.equal(discovered.enabled, false);
  for (const integration of Object.values(discovered.integrations)) assert.equal(integration.status, "disabled");
});
