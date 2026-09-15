import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createBridge,
  getToolDefinitions,
  hasSecret,
  normalizeConfig,
  toSafeError,
  verifyNoReparse,
} from "../src/bridge.mjs";
import { createOptionalBackends } from "../src/optional-backends.mjs";

const LIMITS = { maxResponseBytes: 65_536, timeoutMs: 750 };
const optionalToolNames = ["cbm_status", "cbm_search", "cbm_trace", "cbm_snippet", "context_mode_search"];
const fixtureStub = path.resolve(import.meta.dirname, "fixtures", "optional-backend-stub.mjs");

async function makeFixture() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "codescope-bindings-"));
  const repositories = {};
  for (const alias of ["repo-a", "repo-b"]) {
    const repositoryRoot = path.join(root, alias);
    const contextRoot = path.join(repositoryRoot, ".context");
    await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
    await mkdir(path.join(contextRoot, "corpus"), { recursive: true });
    await mkdir(path.join(contextRoot, "storage"), { recursive: true });
    await writeFile(path.join(repositoryRoot, "src", "graph_fixture.py"), `def ${alias.replaceAll("-", "_")}():\n    return "synthetic"\n`, "utf8");
    await writeFile(path.join(contextRoot, "corpus", "canary.md"), `--- [synthetic|2026-09-13|ctx-canary] ---\n${alias} canary\n`, "utf8");
    await writeFile(path.join(contextRoot, "storage", "state.db"), `${alias}-state\n`, "utf8");
    repositories[alias] = repositoryRoot;
  }
  return { root, repositories };
}

function codebaseMemoryBinding(alias, repositoryRoot, overrides = {}) {
  return {
    enabled: true,
    read_only: true,
    command: process.execPath,
    args: [fixtureStub],
    cwd: repositoryRoot,
    env: {
      OPTIONAL_STUB_MODE: "safe",
      OPTIONAL_STUB_PROJECT: `${alias}-project`,
      OPTIONAL_STUB_ROOT: repositoryRoot,
    },
    project: `${alias}-project`,
    root: repositoryRoot,
    allowed_paths: ["src/graph_fixture.py"],
    ...overrides,
  };
}

function contextModeBinding(alias, repositoryRoot, overrides = {}) {
  return {
    enabled: true,
    read_only: true,
    scope: "synthetic",
    server: process.execPath,
    project_root: repositoryRoot,
    storage: path.join(repositoryRoot, ".context", "storage"),
    session_id: `${alias}-session`,
    source: "ctx-canary",
    corpus_paths: [".context/corpus/canary.md"],
    storage_files: ["state.db"],
    ...overrides,
  };
}

function rawConfig(fixture, aliases = ["repo-a", "repo-b"], sessionAccess) {
  const bindings = Object.fromEntries(aliases.map((alias) => [alias, {
    read_only: true,
    codebase_memory: codebaseMemoryBinding(alias, fixture.repositories[alias]),
    context_mode: contextModeBinding(alias, fixture.repositories[alias]),
  }]));
  return {
    default_repository: aliases[0],
    repositories: Object.fromEntries(aliases.map((alias) => [alias, {
      root: fixture.repositories[alias],
      read_only: true,
    }])),
    optional_backends: { bindings },
    ...(sessionAccess ? { session_access: sessionAccess } : {}),
  };
}

function errorCode(error) {
  return toSafeError(error)?.code || error?.code || null;
}

function assertConfigInvalid(config, label) {
  assert.throws(() => normalizeConfig(config), (error) => errorCode(error) === "config_invalid", label);
}

function sessionOptions(value = "session-a") {
  return { meta: { "openai/session": value } };
}

function installOptionalStubs(bridge) {
  const calls = [];
  const reply = (tool, args = {}) => {
    calls.push({ tool, args });
    return { backend: "synthetic-stub", tool, repository: args.repository || null };
  };
  bridge.optionalBackends = {
    cbmStatus: async (args) => reply("cbm_status", args),
    cbmSearch: async (args) => reply("cbm_search", args),
    cbmTrace: async (args) => reply("cbm_trace", args),
    cbmSnippet: async (args) => reply("cbm_snippet", args),
    contextModeSearch: async (args) => reply("context_mode_search", args),
  };
  return calls;
}

test("bindings are keyed by repository and make repository optional only for one binding", async () => {
  const fixture = await makeFixture();
  try {
    const single = normalizeConfig(rawConfig(fixture, ["repo-a"]));
    const singleTools = getToolDefinitions(single);
    for (const name of optionalToolNames) {
      const tool = singleTools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is advertised for one binding`);
      assert.ok(tool.inputSchema.properties.repository, `${name} accepts repository`);
      assert.equal(tool.inputSchema.required?.includes("repository") || false, false, `${name} keeps repository optional`);
    }

    const multi = normalizeConfig(rawConfig(fixture));
    const multiTools = getToolDefinitions(multi);
    for (const name of optionalToolNames) {
      const tool = multiTools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is advertised for multiple bindings`);
      assert.ok(tool.inputSchema.required?.includes("repository"), `${name} requires repository with multiple bindings`);
    }

    const bridge = createBridge(multi);
    const calls = installOptionalStubs(bridge);
    await assert.rejects(
      bridge.call("cbm_status", {}),
      (error) => errorCode(error) === "repository_required",
      "multiple bindings require repository",
    );
    const result = await bridge.call("cbm_status", { repository: "repo-a" });
    assert.equal(result.tool, "cbm_status");
    assert.equal(result.repository, "repo-a");
    assert.equal(calls.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("binding roots, read-only flags, aliases, and relative scopes are validated", async () => {
  const fixture = await makeFixture();
  try {
    const unknownAlias = rawConfig(fixture);
    unknownAlias.optional_backends.bindings.unknown = {
      codebase_memory: codebaseMemoryBinding("unknown", fixture.repositories["repo-a"]),
    };
    assertConfigInvalid(unknownAlias, "unknown binding alias");

    const wrongRoot = rawConfig(fixture);
    wrongRoot.optional_backends.bindings["repo-a"].codebase_memory.root = fixture.repositories["repo-b"];
    assertConfigInvalid(wrongRoot, "binding root does not match repository");

    const notReadOnly = rawConfig(fixture);
    notReadOnly.optional_backends.bindings["repo-a"].codebase_memory.read_only = false;
    assertConfigInvalid(notReadOnly, "binding must be read-only");

    const outsideStorage = rawConfig(fixture);
    outsideStorage.optional_backends.bindings["repo-a"].context_mode.storage = path.join(fixture.root, "outside-storage");
    assertConfigInvalid(outsideStorage, "Context Mode storage outside repository");

    const escapedCodebasePath = rawConfig(fixture);
    escapedCodebasePath.optional_backends.bindings["repo-a"].codebase_memory.allowed_paths = ["../outside.py"];
    assertConfigInvalid(escapedCodebasePath, "Codebase Memory path escape");

    const escapedCorpusPath = rawConfig(fixture);
    escapedCorpusPath.optional_backends.bindings["repo-a"].context_mode.corpus_paths = ["../outside.md"];
    assertConfigInvalid(escapedCorpusPath, "Context Mode corpus path escape");

    const mixedFormats = rawConfig(fixture, ["repo-a"]);
    mixedFormats.repositories.fixture = mixedFormats.repositories["repo-a"];
    mixedFormats.optional_backends.bindings.fixture = mixedFormats.optional_backends.bindings["repo-a"];
    delete mixedFormats.repositories["repo-a"];
    delete mixedFormats.optional_backends.bindings["repo-a"];
    mixedFormats.default_repository = "fixture";
    mixedFormats.optional_backends.codebase_memory = {
      enabled: true,
      read_only: true,
      command: process.execPath,
      args: [fixtureStub],
      project: "CodeScope-fixture",
      root: fixture.repositories.fixture,
      allowed_paths: ["src/graph_fixture.py"],
    };
    assertConfigInvalid(mixedFormats, "legacy and repository-bound formats cannot overlap");

    const config = normalizeConfig(rawConfig(fixture));
    const bridge = createBridge(config);
    installOptionalStubs(bridge);
    await assert.rejects(
      bridge.call("cbm_status", { repository: "../repo-a" }),
      (error) => errorCode(error) === "invalid_arguments",
      "repository path escape",
    );
    await assert.rejects(
      bridge.call("cbm_status", { repository: "unknown" }),
      (error) => errorCode(error) === "repository_denied",
      "unknown repository alias",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("session selection authorizes only the selected optional binding", async () => {
  const fixture = await makeFixture();
  try {
    const config = normalizeConfig(rawConfig(fixture, ["repo-a", "repo-b"], {
      mode: "session_select",
      require_session: true,
      ttl_seconds: 60,
    }));
    const bridge = createBridge(config);
    installOptionalStubs(bridge);
    const sessionA = sessionOptions();

    await assert.rejects(
      bridge.call("cbm_status", { repository: "repo-a" }, sessionA),
      (error) => errorCode(error) === "repository_access_required",
      "unselected repository",
    );
    await assert.rejects(
      bridge.call("cbm_status", { repository: "repo-a" }),
      (error) => errorCode(error) === "session_required",
      "missing session metadata",
    );

    const selected = await bridge.call("bridge_access_select", { repository: "repo-a" }, sessionA);
    assert.deepEqual(selected.authorized_aliases, ["repo-a"]);
    const readA = await bridge.call("cbm_status", { repository: "repo-a" }, sessionA);
    assert.equal(readA.repository, "repo-a");
    await assert.rejects(
      bridge.call("cbm_search", { repository: "repo-b", query: "canary" }, sessionA),
      (error) => errorCode(error) === "repository_access_denied",
      "repository B must remain inaccessible after selecting A",
    );
    await assert.rejects(
      bridge.call("context_mode_search", { repository: "repo-b", query: "canary" }, sessionA),
      (error) => errorCode(error) === "repository_access_denied",
      "Context Mode B must remain inaccessible after selecting A",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("optional backend input rejects foreign projects, secrets, and path escapes", async () => {
  const fixture = await makeFixture();
  try {
    const repositoryRoot = fixture.repositories["repo-a"];
    const config = {
      limits: LIMITS,
      optionalBackends: {
        codebaseMemory: {
          command: process.execPath,
          args: [fixtureStub],
          cwd: repositoryRoot,
          env: {
            OPTIONAL_STUB_MODE: "safe",
            OPTIONAL_STUB_PROJECT: "repo-a-project",
            OPTIONAL_STUB_ROOT: repositoryRoot,
          },
          project: "repo-a-project",
          root: repositoryRoot,
          allowedPaths: ["src/graph_fixture.py"],
        },
        contextMode: null,
      },
    };
    const backends = createOptionalBackends(config, { hasSecret, verifyNoReparse });
    await assert.rejects(
      backends.cbmSearch({ query: "API_KEY=synthetic-secret", limit: 1 }),
      (error) => errorCode(error) === "secret_denied",
      "secret query",
    );
    await assert.rejects(
      backends.cbmSnippet({ qualified_name: "OtherProject.src.graph_fixture.safe" }),
      (error) => errorCode(error) === "project_boundary",
      "foreign qualified project",
    );
    await assert.rejects(
      backends.cbmSnippet({ qualified_name: "repo-a-project.src.other.secret" }),
      (error) => errorCode(error) === "project_boundary",
      "qualified name outside the allowed source path",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a repository-bound fixture advertises its optional tools", async () => {
  const fixture = await makeFixture();
  try {
    const config = normalizeConfig(rawConfig(fixture, ["repo-a"]));
    const names = getToolDefinitions(config).map((tool) => tool.name);
    assert.ok(names.includes("cbm_status"));
    assert.ok(names.includes("context_mode_search"));
    for (const name of optionalToolNames) {
      const tool = getToolDefinitions(config).find((candidate) => candidate.name === name);
      assert.ok(tool?.inputSchema.properties.repository, `${name} retains repository compatibility`);
      assert.equal(tool.inputSchema.required?.includes("repository") || false, false, `${name} keeps legacy repository optional`);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
