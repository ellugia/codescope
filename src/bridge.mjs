import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOptionalBackends,
  DEFAULT_CBM_COMMAND,
  DEFAULT_CONTEXT_MODE_SERVER,
  isKnownContextModeStorageRoot,
} from "./optional-backends.mjs";
import { DESIGN_GUIDANCE_THEMES, getDesignGuidance } from "./design-guidance.mjs";
import { discoverOptionalIntegrations, DISCOVERY_POLICY } from "./optional-discovery.mjs";
import { resolveConfigPath } from "./config-paths.mjs";

const LEGACY_CONTEXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../characterization/ctx-test");

export const DEFAULT_LIMITS = Object.freeze({
  maxResponseBytes: 64 * 1024,
  maxFileBytes: 512 * 1024,
  maxEntries: 200,
  maxMatches: 100,
  maxLines: 2_000,
  maxDepth: 6,
  maxGitOutputBytes: 128 * 1024,
  maxDiffBytes: 2 * 1024 * 1024,
  timeoutMs: 5_000,
  maxVisited: 5_000,
  maxBaselineFiles: 1_000,
  maxBaselineBytes: 16 * 1024 * 1024,
});

const ALIAS_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const RESERVED_WIN32_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SECRET_NAME_RE = /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|.*(?:password|passwd|api[_-]?key|access[_-]?token).*|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys)$/i;
const SECRET_EXT_RE = /\.(?:pem|key|p12|pfx|jks|kdbx|ovpn)$/i;
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:ghp|github_pat|xox[baprs]|AIza)[A-Za-z0-9_-]{10,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /(?:^|[\0\r\n,{\[?&;])\s*(?:[-+]\s*)?(?:export\s+)?["']?(?:[A-Z][A-Z0-9_-]*?(?:ACCESS[_-]?KEY(?:[_-]?ID)?|API[_-]?KEY|PRIVATE[_-]?(?:TOKEN|KEY)|SECRET[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE)|TOKEN|SECRET[_-]?KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY(?:[_-]?ID)?|PRIVATE[_-]?(?:TOKEN|KEY)|CLIENT[_-]?SECRET)["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^,\s}\]&;]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/iu,
];
const CURSOR_KEY = crypto.randomBytes(32);
const PROCESS_SESSION_HMAC_KEY = crypto.randomBytes(32);
const SESSION_FINGERPRINT_LENGTH = 16;

const TOOL_DEFINITIONS = [
  {
    name: "fs_read_text",
    description: "Read bounded UTF-8 text from a configured repository using 1-based line ranges.",
    inputSchema: objectSchema(
      {
        repository: aliasSchema(),
        path: stringSchema(1, 240),
        start_line: integerSchema(1),
        end_line: integerSchema(1),
        max_bytes: integerSchema(1),
        cursor: stringSchema(1, 2048),
      },
      ["path"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fs_list",
    description: "List bounded, non-secret entries below a configured repository directory. This direct filesystem listing does not replace Codebase Memory or Context Mode queries.",
    inputSchema: objectSchema(
      {
        repository: aliasSchema(),
        path: stringSchema(0, 240),
        max_entries: integerSchema(1),
        cursor: stringSchema(1, 40),
      },
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fs_find",
    description: "Find paths by literal name substring with bounded recursion and results.",
    inputSchema: objectSchema(
      {
        repository: aliasSchema(),
        path: stringSchema(0, 240),
        name_contains: stringSchema(1, 100),
        max_entries: integerSchema(1),
        cursor: stringSchema(1, 40),
      },
      ["name_contains"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fs_search_content",
    description: "Search literal text in bounded UTF-8 files while denying secret-bearing files and matches.",
    inputSchema: objectSchema(
      {
        repository: aliasSchema(),
        path: stringSchema(0, 240),
        query: stringSchema(1, 100),
        max_matches: integerSchema(1),
        cursor: stringSchema(1, 40),
      },
      ["query"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_status",
    description: "Return HEAD, branch, and bounded staged, unstaged, and untracked status entries.",
    inputSchema: objectSchema({ repository: aliasSchema(), max_entries: integerSchema(1), cursor: stringSchema(1, 40) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_head",
    description: "Return the current HEAD SHA and branch without changing Git state.",
    inputSchema: objectSchema({ repository: aliasSchema() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_ref",
    description: "Verify one complete immutable commit SHA and return it if it exists.",
    inputSchema: objectSchema({ repository: aliasSchema(), revision_sha: stringSchema(40, 40) }, ["revision_sha"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_diff_unstaged",
    description: "Return a bounded working-tree diff with external diff and textconv disabled.",
    inputSchema: objectSchema({ repository: aliasSchema(), path: stringSchema(0, 240), context_lines: integerSchema(0), max_bytes: integerSchema(1), cursor: stringSchema(1, 2048) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_diff_staged",
    description: "Return a bounded index diff with external diff and textconv disabled.",
    inputSchema: objectSchema({ repository: aliasSchema(), path: stringSchema(0, 240), context_lines: integerSchema(0), max_bytes: integerSchema(1), cursor: stringSchema(1, 2048) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_diff",
    description: "Return a bounded working-tree diff against one complete immutable commit SHA.",
    inputSchema: objectSchema(
      { repository: aliasSchema(), reference_sha: stringSchema(40, 40), path: stringSchema(0, 240), context_lines: integerSchema(0), max_bytes: integerSchema(1), cursor: stringSchema(1, 2048) },
      ["reference_sha"],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "git_log",
    description: "Return bounded commit history; an optional revision must be a complete immutable SHA-1.",
    inputSchema: objectSchema({ repository: aliasSchema(), revision_sha: stringSchema(40, 40), path: stringSchema(0, 240), max_count: integerSchema(1), cursor: stringSchema(1, 40) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "design_guidance",
    description: "Return the explicit CodeScope design guidance for a code question. This is advisory and never grants repository access or overrides security controls.",
    inputSchema: objectSchema({ theme: stringSchema(1, 32) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ponytail_instructions",
    description: "Return the locally discovered Ponytail rules for adding design guidance to this conversation. This optional tool is exposed only when a validated Ponytail installation is present.",
    inputSchema: objectSchema({ mode: stringSchema(1, 8) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cbm_status",
    description: "Required tool for Codebase Memory state: return the authorized project identity, index status, and bounded freshness observations; use this instead of fs_list for Codebase Memory status.",
    inputSchema: objectSchema({ repository: aliasSchema() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cbm_search",
    description: "Search the authorized Codebase Memory project with a bounded query and filtered source groups.",
    inputSchema: objectSchema({ repository: aliasSchema(), query: stringSchema(1, 160), limit: integerSchema(1), offset: integerSchema(0) }, ["query"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cbm_trace",
    description: "Trace calls in the authorized Codebase Memory project for one qualified symbol.",
    inputSchema: objectSchema({ repository: aliasSchema(), function_name: stringSchema(1, 160), direction: stringSchema(1, 8), depth: integerSchema(1), limit: integerSchema(1) }, ["function_name"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "cbm_snippet",
    description: "Read one filtered source snippet from the authorized Codebase Memory project.",
    inputSchema: objectSchema({ repository: aliasSchema(), qualified_name: stringSchema(1, 160) }, ["qualified_name"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "context_mode_search",
    description: "Search the isolated read-only Context Mode corpus configured for the selected repository.",
    inputSchema: objectSchema({ repository: aliasSchema(), query: stringSchema(1, 160), limit: integerSchema(1) }, ["query"]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "bridge_access_status",
    description: "Call this first to show configured repository aliases and the aliases authorized for this session.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "bridge_access_select",
    description: "Authorize one configured repository alias for this session.",
    inputSchema: objectSchema({ repository: aliasSchema() }, ["repository"]),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "bridge_access_release",
    description: "Revoke one configured repository alias for this session.",
    inputSchema: objectSchema({ repository: aliasSchema() }, ["repository"]),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "bridge_access_reset",
    description: "Revoke every repository alias authorized for this session.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];

export { TOOL_DEFINITIONS };

const OPTIONAL_TOOL_NAMES = new Set(["cbm_status", "cbm_search", "cbm_trace", "cbm_snippet", "context_mode_search"]);
const PONYTAIL_TOOL_NAMES = new Set(["ponytail_instructions"]);
const ACCESS_TOOL_NAMES = new Set(["bridge_access_status", "bridge_access_select", "bridge_access_release", "bridge_access_reset"]);
const REPOSITORY_TOOL_NAMES = new Set([
  "fs_read_text",
  "fs_list",
  "fs_find",
  "fs_search_content",
  "git_status",
  "git_head",
  "git_ref",
  "git_diff_unstaged",
  "git_diff_staged",
  "git_diff",
  "git_log",
]);

export function getToolDefinitions(config) {
  const enabled = new Set();
  if (optionalBackendReady(config, "codebaseMemory")) for (const name of ["cbm_status", "cbm_search", "cbm_trace", "cbm_snippet"]) enabled.add(name);
  if (optionalBackendReady(config, "contextMode")) enabled.add("context_mode_search");
  const backends = config?.optionalBackends || {};
  if (backends.ponytail) for (const name of PONYTAIL_TOOL_NAMES) enabled.add(name);
  const sessionEnabled = config?.sessionAccess?.mode === "session_select";
  return TOOL_DEFINITIONS
    .filter((tool) => ((!OPTIONAL_TOOL_NAMES.has(tool.name) && !PONYTAIL_TOOL_NAMES.has(tool.name)) || enabled.has(tool.name)) && (!ACCESS_TOOL_NAMES.has(tool.name) || sessionEnabled))
    .map((tool) => {
      const kind = tool.name === "context_mode_search" ? "contextMode" : tool.name.startsWith("cbm_") ? "codebaseMemory" : null;
      if (!kind || optionalBackendCount(config, kind) < 2) return tool;
      return { ...tool, inputSchema: { ...tool.inputSchema, required: [...new Set([...(tool.inputSchema.required || []), "repository"])] } };
    });
}

function optionalBackendEntries(config) {
  const backends = config?.optionalBackends || {};
  if (backends.bindings && typeof backends.bindings === "object" && !Array.isArray(backends.bindings)) return Object.entries(backends.bindings);
  const legacy = {};
  if (backends.codebaseMemory || backends.contextMode) legacy.fixture = { alias: "fixture", codebaseMemory: backends.codebaseMemory || null, contextMode: backends.contextMode || null };
  return Object.entries(legacy);
}

function optionalBackendReady(config, kind) {
  return optionalBackendEntries(config).some(([, binding]) => binding?.[kind]?.ready !== false && Boolean(binding?.[kind]));
}

function optionalBackendCount(config, kind) {
  return optionalBackendEntries(config).filter(([, binding]) => Boolean(binding?.[kind])).length;
}

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringSchema(minLength, maxLength) {
  return { type: "string", minLength, maxLength };
}

function integerSchema(minimum) {
  return { type: "integer", minimum };
}

function aliasSchema() {
  return { type: "string", pattern: ALIAS_RE.source };
}

export async function loadConfig(configPath) {
  const selected = resolveConfigPath({ explicitPath: configPath });
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(selected, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new BridgeError("config_missing", "Explicit bridge configuration is required.");
    throw new BridgeError("config_invalid", "Bridge configuration is not valid JSON.");
  }
  const normalized = normalizeConfig(raw);
  const setting = normalized.optionalBackends.autoDiscover;
  if (!setting) return normalized;
  const home = os.homedir();
  const discovery = discoverOptionalIntegrations(setting, {
    basePath: process.env.CODEX_HOME || path.join(home, ".codex"),
    localAppData: process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
    appData: process.env.APPDATA || path.join(home, "AppData", "Roaming"),
  });
  return attachOptionalDiscovery(normalized, discovery);
}

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BridgeError("config_invalid", "Bridge configuration must be an object.");
  if (!raw.repositories || typeof raw.repositories !== "object" || Array.isArray(raw.repositories)) {
    throw new BridgeError("config_invalid", "At least one configured repository is required.");
  }

  const repositories = {};
  for (const [alias, entry] of Object.entries(raw.repositories)) {
    if (!ALIAS_RE.test(alias)) throw new BridgeError("config_invalid", "Repository alias is not allowed.", { field: "repositories" });
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.root !== "string" || !path.isAbsolute(entry.root)) {
      throw new BridgeError("config_invalid", "Repository roots must be absolute and configured locally.", { field: alias });
    }
    if (entry.read_only !== true) throw new BridgeError("config_invalid", "Every repository must explicitly set read_only=true.", { field: alias });
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new BridgeError("config_invalid", "Repository enabled must be a boolean.", { field: `${alias}.enabled` });
    if (entry.enabled === false) continue;
    repositories[alias] = { alias, configuredRoot: path.normalize(entry.root) };
  }

  if (!Object.keys(repositories).length) throw new BridgeError("config_invalid", "At least one active repository is required.");

  const defaultRepository = raw.default_repository || Object.keys(repositories)[0];
  if (!repositories[defaultRepository]) throw new BridgeError("config_invalid", "default_repository must name a configured repository.");

  const limits = { ...DEFAULT_LIMITS };
  if (raw.limits !== undefined) {
    if (!raw.limits || typeof raw.limits !== "object" || Array.isArray(raw.limits)) throw new BridgeError("config_invalid", "limits must be an object.");
    const mapping = {
      max_response_bytes: "maxResponseBytes",
      max_file_bytes: "maxFileBytes",
      max_entries: "maxEntries",
      max_matches: "maxMatches",
      max_lines: "maxLines",
      max_depth: "maxDepth",
      max_git_output_bytes: "maxGitOutputBytes",
      max_diff_bytes: "maxDiffBytes",
      timeout_ms: "timeoutMs",
    };
    for (const [input, output] of Object.entries(mapping)) {
      if (raw.limits[input] === undefined) continue;
      if (!Number.isSafeInteger(raw.limits[input]) || raw.limits[input] < 1 || raw.limits[input] > DEFAULT_LIMITS[output] * 16) {
        throw new BridgeError("config_invalid", "A configured limit is outside the safe range.", { field: input });
      }
      limits[output] = raw.limits[input];
    }
  }

  const gitBinary = raw.git_binary === undefined ? "git" : raw.git_binary;
  if (typeof gitBinary !== "string" || !gitBinary || (gitBinary !== "git" && !path.isAbsolute(gitBinary))) {
    throw new BridgeError("config_invalid", "git_binary must be git or an absolute executable path.");
  }
  const sessionAccess = normalizeSessionAccess(raw.session_access);
  const optionalBackends = normalizeOptionalBackends(raw.optional_backends, repositories);
  return Object.freeze({ repositories: Object.freeze(repositories), defaultRepository, limits: Object.freeze(limits), gitBinary, optionalBackends, sessionAccess });
}

function normalizeSessionAccess(raw) {
  if (raw === undefined) return Object.freeze({ mode: "disabled", requireSession: false, ttlSeconds: 0 });
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.mode !== "session_select" || raw.require_session !== true) {
    throw new BridgeError("config_invalid", "session_access must require session_select with require_session=true.", { field: "session_access" });
  }
  if (!Number.isSafeInteger(raw.ttl_seconds) || raw.ttl_seconds < 60 || raw.ttl_seconds > 86_400) {
    throw new BridgeError("config_invalid", "session_access.ttl_seconds must be an integer between 60 and 86400.", { field: "session_access.ttl_seconds" });
  }
  return Object.freeze({ mode: "session_select", requireSession: true, ttlSeconds: raw.ttl_seconds });
}

function normalizeOptionalBackends(raw, repositories) {
  if (raw === undefined) return Object.freeze({ autoDiscover: false, bindings: Object.freeze({}), codebaseMemory: null, contextMode: null, ponytail: null, discovery: null });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BridgeError("config_invalid", "optional_backends must be an object.");
  const autoDiscover = raw.auto_discover === undefined ? false : raw.auto_discover;
  if (!(autoDiscover === false || autoDiscover === true || (autoDiscover && typeof autoDiscover === "object" && !Array.isArray(autoDiscover)))) {
    throw new BridgeError("config_invalid", "optional_backends.auto_discover must be a boolean or an object.", { field: "optional_backends.auto_discover" });
  }
  const autoDiscoveryEnabled = isAutoDiscoveryEnabled(autoDiscover);
  const bindings = {};
  if (raw.bindings !== undefined) {
    if (!raw.bindings || typeof raw.bindings !== "object" || Array.isArray(raw.bindings)) {
      throw new BridgeError("config_invalid", "optional_backends.bindings must be an object.", { field: "optional_backends.bindings" });
    }
    for (const [alias, entry] of Object.entries(raw.bindings)) {
      if (!repositories[alias]) throw new BridgeError("config_invalid", "Optional backend binding names an unknown repository.", { field: `optional_backends.bindings.${alias}` });
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.read_only === false) {
        throw new BridgeError("config_invalid", "Optional backend bindings must be read-only objects.", { field: `optional_backends.bindings.${alias}` });
      }
      const legacyBinding = alias === "fixture"
        && entry.context_mode?.scope === "synthetic"
        && typeof entry.context_mode.project_root === "string"
        && sameConfigPath(path.normalize(entry.context_mode.project_root), LEGACY_CONTEXT_ROOT);
      if (entry.read_only !== true && ![entry.codebase_memory, entry.context_mode].some((backend) => backend && backend.read_only === true)) {
        throw new BridgeError("config_invalid", "Optional backend bindings must explicitly set read_only=true.", { field: `optional_backends.bindings.${alias}` });
      }
      const codebaseMemory = normalizeCodebaseMemory(entry.codebase_memory, repositories, alias, { legacy: legacyBinding, autoDiscoveryEnabled });
      const contextMode = normalizeContextMode(entry.context_mode, repositories, alias, { legacy: legacyBinding, autoDiscoveryEnabled });
      const disabledBinding = [entry.codebase_memory, entry.context_mode].filter(Boolean).length > 0
        && [entry.codebase_memory, entry.context_mode].filter(Boolean).every((backend) => backend.enabled === false);
      if (!codebaseMemory && !contextMode && !disabledBinding) throw new BridgeError("config_invalid", "Optional backend binding must configure at least one backend.", { field: `optional_backends.bindings.${alias}` });
      bindings[alias] = Object.freeze({ alias, readOnly: true, codebaseMemory, contextMode });
    }
  }

  const hasLegacyCodebase = raw.codebase_memory !== undefined;
  const hasLegacyContext = raw.context_mode !== undefined;
  const legacyCodebase = hasLegacyCodebase
    ? normalizeCodebaseMemory(raw.codebase_memory, repositories, "fixture", { legacy: true, autoDiscoveryEnabled })
    : null;
  const legacyContext = hasLegacyContext
    ? normalizeContextMode(raw.context_mode, repositories, "fixture", { legacy: true, autoDiscoveryEnabled })
    : null;
  if ((legacyCodebase || legacyContext) && !repositories.fixture) {
    throw new BridgeError("config_invalid", "Legacy optional backend configuration requires the fixture repository.", { field: "optional_backends" });
  }
  if ((hasLegacyCodebase || hasLegacyContext) && raw.bindings !== undefined) {
    throw new BridgeError("config_invalid", "Legacy and repository-bound optional backend configuration cannot overlap.", { field: "optional_backends.bindings" });
  }
  if (legacyCodebase || legacyContext) {
    bindings.fixture = Object.freeze({
      alias: "fixture",
      readOnly: true,
      codebaseMemory: legacyCodebase,
      contextMode: legacyContext,
    });
  }
  const frozenBindings = Object.freeze(bindings);
  return Object.freeze({
    autoDiscover,
    bindings: frozenBindings,
    // Keep the old fields as a compatibility view for callers that used the fixture config directly.
    codebaseMemory: bindings.fixture?.codebaseMemory || legacyCodebase,
    contextMode: bindings.fixture?.contextMode || legacyContext,
    ponytail: null,
    discovery: null,
  });
}

function attachOptionalDiscovery(config, discovery) {
  const ponytail = discovery.integrations.ponytail?.status === "validated"
    ? {
      root: discovery.integrations.ponytail.path,
      entrypoint: path.join(discovery.integrations.ponytail.path, "ponytail-mcp", "instructions.js"),
      version: discovery.integrations.ponytail.version || null,
    }
    : null;
  const autoDiscoveryEnabled = isAutoDiscoveryEnabled(config.optionalBackends.autoDiscover);
  const bindings = Object.fromEntries(Object.entries(config.optionalBackends.bindings || {}).map(([alias, binding]) => [
    alias,
    Object.freeze({
      ...binding,
      codebaseMemory: resolveDiscoveredBackend(binding.codebaseMemory, discovery.integrations.codebase_memory, autoDiscoveryEnabled, "codebase_memory"),
      contextMode: resolveDiscoveredBackend(binding.contextMode, discovery.integrations.context_mode, autoDiscoveryEnabled, "context_mode"),
    }),
  ]));
  const optionalBackends = Object.freeze({
    ...config.optionalBackends,
    bindings: Object.freeze(bindings),
    codebaseMemory: bindings.fixture?.codebaseMemory || null,
    contextMode: bindings.fixture?.contextMode || null,
    ponytail,
    discovery,
  });
  return Object.freeze({ ...config, optionalBackends });
}

function normalizeCodebaseMemory(raw, repositories, alias = "fixture", { legacy = false, autoDiscoveryEnabled = false } = {}) {
  if (raw === undefined || raw === null || raw.enabled === false) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.enabled !== true || raw.read_only !== true) {
    throw new BridgeError("config_invalid", "Codebase Memory must be explicitly enabled read-only.");
  }
  const repository = repositories[alias];
  if (!repository) throw new BridgeError("config_invalid", "Codebase Memory binding names an unknown repository.", { field: alias });
  const root = configAbsolutePath(raw.root, "optional_backends.codebase_memory.root");
  if (!sameConfigPath(root, repository.configuredRoot)) {
    throw new BridgeError("config_invalid", "Codebase Memory root must match its repository binding.", { field: "optional_backends.codebase_memory.root" });
  }
  const project = safeBackendIdentifier(raw.project, "optional_backends.codebase_memory.project");
  if (legacy && project !== "CodeScope-fixture") throw new BridgeError("config_invalid", "Legacy Codebase Memory is restricted to the CodeScope-fixture project.");
  const allowedPaths = normalizeBackendPaths(raw.allowed_paths || (legacy ? ["src/graph_fixture.py"] : undefined), "optional_backends.codebase_memory.allowed_paths");
  if (legacy && (allowedPaths.length !== 1 || allowedPaths[0] !== "src/graph_fixture.py")) throw new BridgeError("config_invalid", "Legacy Codebase Memory source scope is restricted to the fixture canary file.");
  const commandExplicit = raw.command !== undefined;
  const command = commandExplicit
    ? configAbsolutePath(raw.command, "optional_backends.codebase_memory.command")
    : autoDiscoveryEnabled ? null : configAbsolutePath(DEFAULT_CBM_COMMAND, "optional_backends.codebase_memory.command");
  const args = normalizeBackendArgs(raw.args, "optional_backends.codebase_memory.args");
  return Object.freeze({
    command,
    args: Object.freeze(args),
    cwd: root,
    env: Object.freeze({}),
    project,
    root,
    allowedPaths: Object.freeze(allowedPaths),
    ready: !autoDiscoveryEnabled && Boolean(command),
    commandExplicit,
    legacy,
  });
}

function normalizeContextMode(raw, repositories, alias = "fixture", { legacy = false, autoDiscoveryEnabled = false } = {}) {
  if (raw === undefined || raw === null || raw.enabled === false) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.enabled !== true || raw.read_only !== true) {
    throw new BridgeError("config_invalid", "Context Mode must be explicitly enabled read-only.");
  }
  const repository = repositories[alias];
  if (!repository) throw new BridgeError("config_invalid", "Context Mode binding names an unknown repository.", { field: alias });
  const projectRoot = configAbsolutePath(raw.project_root, "optional_backends.context_mode.project_root");
  const storage = configAbsolutePath(raw.storage, "optional_backends.context_mode.storage");
  const storageRootKnown = !legacy && isKnownContextModeStorageRoot(storage);
  if (legacy) {
    if (raw.scope !== "synthetic") throw new BridgeError("config_invalid", "Legacy Context Mode requires the synthetic scope.");
    const authorizedRoot = configAbsolutePath(LEGACY_CONTEXT_ROOT, "optional_backends.context_mode.project_root");
    if (!sameConfigPath(projectRoot, authorizedRoot) || !sameConfigPath(storage, path.join(projectRoot, "storage-session"))) {
      throw new BridgeError("config_invalid", "Legacy Context Mode is restricted to the synthetic ctx-test corpus.");
    }
  } else {
    if (!sameConfigPath(projectRoot, repository.configuredRoot) || (!isStrictChildPath(projectRoot, storage) && !storageRootKnown)) {
      throw new BridgeError("config_invalid", "Context Mode project_root must match its repository and storage must remain inside it or use a known Context Mode storage root.");
    }
  }
  const sessionId = raw.session_id === undefined || raw.session_id === null
    ? null
    : safeBackendIdentifier(raw.session_id, "optional_backends.context_mode.session_id");
  const source = raw.source === undefined || raw.source === null
    ? null
    : safeBackendIdentifier(raw.source, "optional_backends.context_mode.source");
  const queryMode = raw.query_mode === undefined ? "relevance" : safeBackendIdentifier(raw.query_mode, "optional_backends.context_mode.query_mode");
  if (queryMode !== "relevance" && queryMode !== "timeline") {
    throw new BridgeError("config_invalid", "Context Mode query_mode must be relevance or timeline.");
  }
  if (legacy && (sessionId !== "ctx-canary-session-20260910" || source !== "ctx-canary")) {
    throw new BridgeError("config_invalid", "Legacy Context Mode session and source are restricted to the synthetic canary.");
  }
  const corpusPaths = raw.corpus_paths === undefined
    ? (legacy ? ["corpus/canary.md"] : storageRootKnown ? [] : normalizeBackendPaths(undefined, "optional_backends.context_mode.corpus_paths"))
    : normalizeBackendPaths(raw.corpus_paths, "optional_backends.context_mode.corpus_paths", { allowEmpty: storageRootKnown && !legacy });
  if (legacy && (corpusPaths.length !== 1 || corpusPaths[0] !== "corpus/canary.md")) throw new BridgeError("config_invalid", "Legacy Context Mode corpus scope is restricted to the synthetic canary file.");
  const storageFiles = normalizeBackendPaths(raw.storage_files || (legacy ? [
    "content/356401f6d63e750b.db",
    "sessions/stats-ctx-canary-session-20260910.json",
  ] : undefined), "optional_backends.context_mode.storage_files");
  if (legacy) {
    const expectedStorageFiles = [
      "content/356401f6d63e750b.db",
      "sessions/stats-ctx-canary-session-20260910.json",
    ];
    if (storageFiles.length !== expectedStorageFiles.length || storageFiles.some((value, index) => value !== expectedStorageFiles[index])) {
      throw new BridgeError("config_invalid", "Legacy Context Mode storage scope is restricted to the synthetic canary files.");
    }
  }
  const serverExplicit = raw.server !== undefined;
  const server = serverExplicit
    ? configAbsolutePath(raw.server, "optional_backends.context_mode.server")
    : autoDiscoveryEnabled ? null : configAbsolutePath(DEFAULT_CONTEXT_MODE_SERVER, "optional_backends.context_mode.server");
  const scope = raw.scope === undefined ? "bound" : safeBackendIdentifier(raw.scope, "optional_backends.context_mode.scope");
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze(server ? [server] : []),
    cwd: projectRoot,
    env: Object.freeze({
      CONTEXT_MODE_DIR: storage,
      CONTEXT_MODE_PROJECT_DIR: projectRoot,
      CLAUDE_PROJECT_DIR: projectRoot,
      ...(sessionId ? { CLAUDE_SESSION_ID: sessionId } : {}),
      CONTEXT_MODE_PLATFORM: "codex",
    }),
    projectRoot,
    storage,
    storageRootKnown,
    sessionId,
    source,
    queryMode,
    project: safeBackendIdentifier(raw.project || path.basename(projectRoot), "optional_backends.context_mode.project"),
    scope,
    corpusPaths: Object.freeze(corpusPaths),
    storageFiles: Object.freeze(storageFiles),
    ready: !autoDiscoveryEnabled && Boolean(server),
    server,
    serverExplicit,
    legacy,
  });
}

function isAutoDiscoveryEnabled(setting) {
  return setting === true || Boolean(setting && typeof setting === "object" && (setting.enabled === true || setting.autodiscovery === true));
}

function resolveDiscoveredBackend(config, discovered, autoDiscoveryEnabled, name) {
  if (!config) return null;
  if (!autoDiscoveryEnabled) return config;
  const validated = discovered?.status === "validated" && typeof discovered.path === "string";
  if (!validated) return Object.freeze({ ...config, ready: false, unavailableReason: discovered?.reason || "discovery_unvalidated" });
  if (name === "codebase_memory") {
    if (config.command && !sameConfigPath(config.command, discovered.path)) return Object.freeze({ ...config, ready: false, unavailableReason: "command_not_validated" });
    return Object.freeze({ ...config, command: config.command || discovered.path, ready: true, discovered: true });
  }
  if (config.server && !sameConfigPath(config.server, discovered.path)) return Object.freeze({ ...config, ready: false, unavailableReason: "server_not_validated" });
  return Object.freeze({
    ...config,
    server: config.server || discovered.path,
    args: Object.freeze([config.server || discovered.path]),
    ready: true,
    discovered: true,
  });
}

function safeBackendIdentifier(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || /[\0\x00-\x1f\x7f\\/]/u.test(value)) {
    throw new BridgeError("config_invalid", "Optional backend identifiers must be explicit safe text.", { field });
  }
  return value;
}

function readSessionIdentity(meta) {
  const raw = meta && typeof meta === "object" ? meta["openai/session"] : undefined;
  return typeof raw === "string" && raw.length >= 1 && raw.length <= 4_096 && !/[\0-\x1f\x7f]/u.test(raw) ? raw : null;
}

function normalizeBackendArgs(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some((entry) => typeof entry !== "string" || entry.length > 240 || /[\0\x00-\x1f\x7f]/u.test(entry))) {
    throw new BridgeError("config_invalid", "Optional backend command arguments are outside their bound.", { field });
  }
  return [...value];
}

function isStrictChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function configAbsolutePath(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\x00-\x1f\x7f]/u.test(value)) throw new BridgeError("config_invalid", "Configured backend paths must be absolute and safe.", { field });
  return path.normalize(value);
}

function normalizeBackendPaths(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > 8 || (!allowEmpty && value.length < 1)) throw new BridgeError("config_invalid", "Configured backend paths are outside their bound.", { field });
  return value.map((entry) => {
    try {
      return normalizeRelativePath(entry, false);
    } catch {
      throw new BridgeError("config_invalid", "Configured backend paths must be safe relative paths.", { field });
    }
  });
}

function sameConfigPath(left, right) {
  const normalize = (value) => path.normalize(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function deriveSessionHmacKey(config) {
  const scope = JSON.stringify({
    repositories: Object.entries(config.repositories)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([alias, entry]) => [alias, entry.configuredRoot]),
    defaultRepository: config.defaultRepository,
    sessionAccess: config.sessionAccess,
    optionalBindings: Object.keys(config.optionalBackends?.bindings || {}).sort(),
  });
  return crypto.createHmac("sha256", PROCESS_SESSION_HMAC_KEY).update(scope, "utf8").digest();
}

export function createBridge(config) {
  return new Bridge(config);
}

class Bridge {
  constructor(config) {
    this.config = config;
    this.rootCache = new Map();
    this.sessionStates = new Map();
    this.sessionHmacKey = deriveSessionHmacKey(config);
    this.inFlight = false;
    this.optionalBackends = createOptionalBackends(config, { hasSecret, verifyNoReparse });
  }

  async prepare() {
    for (const alias of Object.keys(this.config.repositories)) await this.repository(alias);
    return this;
  }

  async repository(requested) {
    const alias = requested === undefined ? this.config.defaultRepository : requested;
    if (typeof alias !== "string" || !ALIAS_RE.test(alias) || !this.config.repositories[alias]) {
      throw new BridgeError("repository_denied", "Repository alias is not authorized.");
    }
    const entry = this.config.repositories[alias];
    const root = await canonicalRoot(entry.configuredRoot);
    let rootStat;
    try {
      rootStat = await fs.lstat(root);
    } catch {
      throw new BridgeError("repository_unavailable", "Configured repository is unavailable.");
    }
    const rootIdentity = makeRootIdentity(root, rootStat);
    const cached = this.rootCache.get(alias);
    if (cached && (cached.root !== root || cached.rootIdentity !== rootIdentity)) throw new BridgeError("repository_changed", "Configured repository identity changed.");
    const result = Object.freeze({ alias, root, rootIdentity });
    this.rootCache.set(alias, result);
    return result;
  }

  async call(name, args = {}, options = {}) {
    if (!getToolDefinitions(this.config).some((tool) => tool.name === name)) throw new BridgeError("tool_denied", "Tool is not in the allowlist.");
    if (this.inFlight) throw new BridgeError("concurrency_limit", "Only one bridge operation may run at a time.");
    this.inFlight = true;
    const sessionMode = this.config.sessionAccess?.mode === "session_select";
    let session = null;
    let contextSessionIdentity = null;
    let optionalRepository;
    try {
      const input = validateArguments(name, args);
      if (sessionMode) {
        session = this.sessionContext(options?.meta);
        contextSessionIdentity = session.fingerprint;
        if (REPOSITORY_TOOL_NAMES.has(name)) this.requireRepositoryAccess(input.repository, session);
        if (OPTIONAL_TOOL_NAMES.has(name)) {
          optionalRepository = this.resolveOptionalRepository(name, input.repository);
          this.requireRepositoryAccess(optionalRepository, session);
        }
      } else if (OPTIONAL_TOOL_NAMES.has(name)) {
        optionalRepository = this.resolveOptionalRepository(name, input.repository);
        if (name === "context_mode_search") {
          const rawSession = readSessionIdentity(options?.meta);
          contextSessionIdentity = rawSession ? this.sessionFingerprint(rawSession) : null;
        }
      }
      const optionalInput = OPTIONAL_TOOL_NAMES.has(name) ? { ...input, repository: optionalRepository } : input;
      let result;
      switch (name) {
        case "fs_read_text": result = await this.readText(input); break;
        case "fs_list": result = await this.list(input); break;
        case "fs_find": result = await this.find(input); break;
        case "fs_search_content": result = await this.searchContent(input); break;
        case "git_status": result = await this.gitStatus(input); break;
        case "git_head": result = await this.gitHeadInfo(input); break;
        case "git_ref": result = await this.gitRef(input); break;
        case "git_diff_unstaged": result = await this.gitDiff(input, false); break;
        case "git_diff_staged": result = await this.gitDiff(input, true); break;
        case "git_diff": result = await this.gitDiffReference(input); break;
        case "git_log": result = await this.gitLog(input); break;
        case "design_guidance": result = this.designGuidance(input); break;
        case "ponytail_instructions": result = await this.ponytailInstructions(input); break;
        case "cbm_status": result = await this.optionalBackends.cbmStatus(optionalInput); break;
        case "cbm_search": result = await this.optionalBackends.cbmSearch(optionalInput); break;
        case "cbm_trace": result = await this.optionalBackends.cbmTrace(optionalInput); break;
        case "cbm_snippet": result = await this.optionalBackends.cbmSnippet(optionalInput); break;
        case "context_mode_search": result = await this.optionalBackends.contextModeSearch(optionalInput, contextSessionIdentity); break;
        case "bridge_access_status": result = this.accessStatus(session); break;
        case "bridge_access_select": result = await this.accessSelect(input, session); break;
        case "bridge_access_release": result = this.accessRelease(input, session); break;
        case "bridge_access_reset": result = this.accessReset(session); break;
        default: throw new BridgeError("tool_denied", "Tool is not in the allowlist.");
      }
      return this.decorateResult(result, session);
    } catch (error) {
      if (sessionMode) this.decorateError(error, session);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  sessionContext(meta) {
    const raw = readSessionIdentity(meta);
    if (!raw) {
      throw new BridgeError("session_required", "An OpenAI session is required for bridge access.", this.securityDetails(null));
    }
    const fingerprint = this.sessionFingerprint(raw);
    const now = Date.now();
    for (const [key, candidate] of this.sessionStates) {
      if (candidate.expiresAt <= now) this.sessionStates.delete(key);
    }
    let state = this.sessionStates.get(fingerprint);
    if (!state || state.expiresAt <= now) {
      state = { authorized: new Set(), expiresAt: now + this.config.sessionAccess.ttlSeconds * 1_000 };
      this.sessionStates.set(fingerprint, state);
    }
    return { fingerprint, state };
  }

  sessionFingerprint(raw) {
    return crypto.createHmac("sha256", this.sessionHmacKey).update(raw, "utf8").digest("hex");
  }

  securityDetails(session) {
    return {
      security_notice: "Repository access is session-scoped; only explicitly selected configured aliases are available.",
      session_fingerprint: session ? session.fingerprint.slice(0, SESSION_FINGERPRINT_LENGTH) : "unavailable",
      configured_aliases: Object.keys(this.config.repositories),
      authorized_aliases: session ? this.authorizedAliases(session) : [],
      optional_integrations: this.optionalIntegrationStatus(),
    };
  }

  optionalIntegrationStatus() {
    const discovery = this.config.optionalBackends?.discovery;
    const integrations = discovery?.integrations || {};
    const names = ["ponytail", "codebase_memory", "context_mode"];
    const bindings = optionalBackendEntries(this.config);
    const integrationStatus = Object.fromEntries(names.map((name) => {
      const kind = name === "codebase_memory" ? "codebaseMemory" : name === "context_mode" ? "contextMode" : null;
      const item = integrations[name];
      if (!kind) {
        const configured = Boolean(this.config.optionalBackends?.ponytail);
        return [name, item ? {
          status: item.status,
          found: item.found === true,
          validated: item.validated === true,
          ready: configured,
          ...(item.version ? { version: item.version } : {}),
          ...(item.reason ? { reason: item.reason } : (!configured && item.validated ? { reason: "scope_binding_required" } : {})),
        } : { status: configured ? "configured" : "not_configured", found: configured, validated: configured, ready: configured }];
      }
      const configuredBindings = bindings.filter(([, binding]) => Boolean(binding?.[kind]));
      const byRepository = Object.fromEntries(configuredBindings.map(([alias, binding]) => {
        const backend = binding[kind];
        return [alias, {
          ready: backend.ready !== false,
          status: name === "context_mode"
            ? (backend.ready !== false ? "available" : "unavailable")
            : (backend.ready !== false ? (item?.status || "configured") : (item?.status || "unavailable")),
          ...(backend.unavailableReason ? { reason: backend.unavailableReason } : {}),
        }];
      }));
      const ready = Object.values(byRepository).some((entry) => entry.ready);
      const bindingReason = Object.values(byRepository).find((entry) => entry.reason)?.reason;
      const status = name === "context_mode"
        ? (configuredBindings.length === 0 ? "not_configured" : ready ? "available" : "unavailable")
        : item?.status || (ready ? "configured" : configuredBindings.length ? "pending_validation" : "not_configured");
      return [name, item ? {
        status,
        found: item.found === true,
        validated: item.validated === true,
        ready,
        bindings: byRepository,
        ready_repositories: Object.entries(byRepository).filter(([, entry]) => entry.ready).map(([alias]) => alias).sort(),
        ...(item.version ? { version: item.version } : {}),
        ...(item.reason ? { reason: item.reason } : (bindingReason ? { reason: bindingReason } : (!ready && item.validated ? { reason: "scope_binding_required" } : {}))),
      } : {
        status,
        found: configuredBindings.length > 0,
        validated: configuredBindings.length > 0 && ready,
        ready,
        bindings: byRepository,
        ready_repositories: Object.entries(byRepository).filter(([, entry]) => entry.ready).map(([alias]) => alias).sort(),
      }];
    }));
    return {
      policy: discovery?.policy || DISCOVERY_POLICY,
      autodiscovery: discovery ? discovery.enabled === true : isAutoDiscoveryEnabled(this.config.optionalBackends?.autoDiscover),
      ready: Object.values(integrationStatus).some((entry) => entry.ready === true),
      integrations: integrationStatus,
    };
  }

  authorizedAliases(session) {
    return [...session.state.authorized].sort();
  }

  requireRepositoryAccess(requested, session) {
    const alias = requested === undefined ? this.config.defaultRepository : requested;
    if (typeof alias !== "string" || !ALIAS_RE.test(alias) || !this.config.repositories[alias]) {
      throw new BridgeError("repository_denied", "Repository alias is not authorized.");
    }
    if (session.state.authorized.size === 0) {
      throw new BridgeError("repository_access_required", "Select a configured repository before reading it.");
    }
    if (!session.state.authorized.has(alias)) {
      throw new BridgeError("repository_access_denied", "The repository is not authorized for this session.");
    }
  }

  resolveOptionalRepository(tool, requested) {
    const kind = tool === "context_mode_search" ? "contextMode" : "codebaseMemory";
    const entries = optionalBackendEntries(this.config).filter(([, binding]) => Boolean(binding?.[kind]));
    if (requested !== undefined) {
      if (typeof requested !== "string" || !ALIAS_RE.test(requested) || !this.config.repositories[requested]) {
        throw new BridgeError("repository_denied", "Repository alias is not authorized.");
      }
      const selected = optionalBackendEntries(this.config).find(([alias]) => alias === requested)?.[1]?.[kind];
      if (!selected) throw new BridgeError("repository_denied", "The requested repository has no binding for this optional backend.", { repository: requested });
      if (selected.ready === false) throw new BridgeError("backend_unavailable", "The optional backend binding is not ready.", { repository: requested, reason: selected.unavailableReason || "discovery_unvalidated" });
      return requested;
    }
    const ready = entries.filter(([, binding]) => binding[kind].ready !== false);
    if (entries.length > 1) throw new BridgeError("repository_required", "Specify repository for the optional backend.");
    if (ready.length === 1) return ready[0][0];
    if (entries.length === 1) throw new BridgeError("backend_unavailable", "The optional backend binding is not ready.", { repository: entries[0][0], reason: entries[0][1][kind].unavailableReason || "discovery_unvalidated" });
    throw new BridgeError("backend_unavailable", "No repository binding is configured for the optional backend.");
  }

  accessStatus(session) {
    return {
      ...this.securityDetails(session),
      authorized_aliases: this.authorizedAliases(session),
      expires_at: new Date(session.state.expiresAt).toISOString(),
    };
  }

  designGuidance(args) {
    const theme = args?.theme ?? "general";
    if (typeof theme !== "string" || !DESIGN_GUIDANCE_THEMES.includes(theme)) {
      throw new BridgeError("invalid_arguments", "Unknown design guidance theme.", { field: "theme", allowed: DESIGN_GUIDANCE_THEMES });
    }
    return {
      ...getDesignGuidance(theme),
      security_notice: "Design guidance is advisory; repository access remains controlled by the bridge allowlist and session authorization.",
      integration: {
        name: "Ponytail-compatible design guidance",
        theme,
        source: "CodeScope policy",
        optional_dependency: "ponytail",
        used_as: "advisory guidance",
      },
    };
  }

  async ponytailInstructions(args) {
    const config = this.config.optionalBackends?.ponytail;
    if (!config) throw new BridgeError("backend_unavailable", "Ponytail was not discovered or validated on this host.", { integration: "ponytail" });
    const mode = args?.mode === undefined ? undefined : args.mode;
    if (mode !== undefined && !["lite", "full", "ultra"].includes(mode)) {
      throw new BridgeError("invalid_arguments", "Ponytail mode must be lite, full, or ultra.", { field: "mode" });
    }
    const entrypoint = await this.safePonytailEntrypoint(config);
    let module;
    try {
      module = await import(pathToFileURL(entrypoint).href);
    } catch {
      throw new BridgeError("backend_unavailable", "The discovered Ponytail instruction module could not be loaded.", { integration: "ponytail" });
    }
    let instructions;
    let resolvedMode;
    try {
      resolvedMode = typeof module.resolveMode === "function" ? module.resolveMode(mode) : (mode || "full");
      instructions = module.buildInstructions(resolvedMode);
    } catch {
      throw new BridgeError("backend_unavailable", "The discovered Ponytail instruction module rejected the request.", { integration: "ponytail" });
    }
    if (typeof instructions !== "string" || !instructions || instructions.length > this.config.limits.maxResponseBytes) {
      throw new BridgeError("output_limit", "Ponytail instructions exceeded the bridge response bound.", { integration: "ponytail" });
    }
    if (hasSecret(instructions)) throw new BridgeError("secret_denied", "Ponytail instructions contained protected content.", { integration: "ponytail" });
    return {
      backend: "ponytail",
      mode: resolvedMode,
      version: config.version,
      instructions,
      provenance: {
        source: "validated local Ponytail installation",
        advisory: true,
        trusted_instruction_source: true,
      },
      security_notice: "Ponytail guidance is advisory; it never grants repository access or overrides bridge security controls.",
    };
  }

  async safePonytailEntrypoint(config) {
    const root = path.resolve(config.root);
    const entrypoint = path.resolve(config.entrypoint);
    const relative = path.relative(root, entrypoint);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.replaceAll("\\", "/").startsWith("ponytail-mcp/")) {
      throw new BridgeError("backend_unavailable", "The discovered Ponytail entrypoint is outside its validated installation.", { integration: "ponytail" });
    }
    let stat;
    let real;
    let realRoot;
    try {
      stat = await fs.lstat(entrypoint);
      real = await fs.realpath(entrypoint);
      realRoot = await fs.realpath(root);
    } catch {
      throw new BridgeError("backend_unavailable", "The discovered Ponytail entrypoint is unavailable.", { integration: "ponytail" });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BridgeError("backend_unavailable", "The discovered Ponytail entrypoint is not a stable file.", { integration: "ponytail" });
    const realRelative = path.relative(realRoot, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new BridgeError("backend_unavailable", "The discovered Ponytail entrypoint changed scope.", { integration: "ponytail" });
    return real;
  }

  async accessSelect(args, session) {
    const repository = await this.repository(args.repository);
    const previous = this.authorizedAliases(session);
    session.state.authorized.add(repository.alias);
    return {
      ...this.securityDetails(session),
      previous_authorized_aliases: previous,
      authorized_aliases: this.authorizedAliases(session),
      event: "access_granted",
      expires_at: new Date(session.state.expiresAt).toISOString(),
    };
  }

  accessRelease(args, session) {
    if (!this.config.repositories[args.repository]) throw new BridgeError("repository_denied", "Repository alias is not authorized.");
    const previous = this.authorizedAliases(session);
    session.state.authorized.delete(args.repository);
    return {
      ...this.securityDetails(session),
      previous_authorized_aliases: previous,
      authorized_aliases: this.authorizedAliases(session),
      event: "access_revoked",
    };
  }

  accessReset(session) {
    const previous = this.authorizedAliases(session);
    session.state.authorized.clear();
    return {
      ...this.securityDetails(session),
      previous_authorized_aliases: previous,
      authorized_aliases: [],
      event: "access_reset",
    };
  }

  decorateResult(result, session) {
    if (!session) return result;
    return { ...result, security_notice: this.securityDetails(session).security_notice };
  }

  decorateError(error, session) {
    const details = this.securityDetails(session);
    if (error instanceof BridgeError || error?.name === "OptionalBackendError") {
      error.details = { ...(error.details || {}), ...details };
      return;
    }
    throw new BridgeError("internal_error", "Bridge operation failed.", details);
  }

  async readText(args) {
    const repo = await this.repository(args.repository);
    const target = await this.resolvePath(repo, args.path, "file");
    if (isSecretPath(target.relative)) throw new BridgeError("secret_denied", "The requested path is protected.");
    const contentBudget = Math.max(1, this.config.limits.maxResponseBytes - 2_048);
    const maxBytes = boundedInt(args.max_bytes, "max_bytes", 1, Math.min(this.config.limits.maxFileBytes, contentBudget), Math.min(this.config.limits.maxFileBytes, contentBudget));
    const cursor = decodeReadCursor(args.cursor);
    const observed = await observeFile(target.absolute, target.stat, repo.rootIdentity, this.config.limits.maxFileBytes);
    if (cursor && !sameFileCursor(cursor, target.relative, observed)) throw new BridgeError("cursor_stale", "Cursor does not match the current file version.");
    const startLine = boundedInt(args.start_line, "start_line", 1, Number.MAX_SAFE_INTEGER, cursor?.line || 1);
    if (cursor && args.start_line !== undefined && args.start_line !== cursor.line) throw new BridgeError("invalid_arguments", "start_line must match cursor.line.");
    const endLine = boundedInt(args.end_line, "end_line", startLine, startLine + this.config.limits.maxLines - 1, startLine + this.config.limits.maxLines - 1);
    const range = await readLineRange(target.absolute, target.stat, target.relative, startLine, endLine, this.config.limits.maxFileBytes, maxBytes, cursor, observed);
    const after = await observeFile(target.absolute, target.stat, repo.rootIdentity, this.config.limits.maxFileBytes);
    if (!sameFileIdentity(observed, after)) throw new BridgeError("path_changed", "The file changed while it was being read.");
    const result = { repository: repo.alias, path: target.relative, start_line: startLine, end_line: range.endLine, text: range.text, bytes_scanned: range.bytesScanned, truncated: range.truncated, next_cursor: range.nextCursor, max_bytes: maxBytes };
    audit("fs_read_text", repo.alias, target.relative, range.truncated ? "truncated" : "ok", range.bytesScanned);
    return result;
  }

  async list(args) {
    const repo = await this.repository(args.repository);
    const target = await this.resolvePath(repo, args.path || "", "directory");
    const requestedLimit = boundedInt(args.max_entries, "max_entries", 1, this.config.limits.maxEntries, this.config.limits.maxEntries);
    const cursor = parseCursor(args.cursor);
    const entries = [];
    let denied = 0;
    for (const entry of (await readDirectory(target.absolute, repo.root)).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = joinRelative(target.relative, entry.name);
      if (entry.isSymbolicLink()) throw new BridgeError("path_denied", "Symlinks and reparse points are not allowed in a listing.");
      if (isSecretPath(relative)) {
        denied += 1;
        continue;
      }
      entries.push({ path: relative, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
    }
    const page = pageResult(entries, cursor, requestedLimit, { repository: repo.alias, path: target.relative, denied_count: denied });
    audit("fs_list", repo.alias, target.relative, page.truncated ? "truncated" : "ok", page.entries.length);
    return page;
  }

  async find(args) {
    const repo = await this.repository(args.repository);
    const target = await this.resolvePath(repo, args.path || "", "directory");
    const requestedLimit = boundedInt(args.max_entries, "max_entries", 1, this.config.limits.maxEntries, this.config.limits.maxEntries);
    const cursor = parseCursor(args.cursor);
    const needle = args.name_contains.toLocaleLowerCase();
    const found = [];
    const queue = [{ absolute: target.absolute, relative: target.relative, depth: 0 }];
    let visited = 0;
    let denied = 0;
    while (queue.length && visited < this.config.limits.maxVisited) {
      const current = queue.shift();
      const children = await readDirectory(current.absolute, repo.root);
      for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
        visited += 1;
        const relative = joinRelative(current.relative, entry.name);
        if (entry.isSymbolicLink()) throw new BridgeError("path_denied", "Symlinks and reparse points are not allowed in a search.");
        if (isSecretPath(relative)) {
          denied += 1;
          continue;
        }
        if (entry.name.toLocaleLowerCase().includes(needle)) found.push({ path: relative, type: entry.isDirectory() ? "directory" : "file" });
        if (entry.isDirectory() && current.depth < this.config.limits.maxDepth) queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        if (visited >= this.config.limits.maxVisited) break;
      }
    }
    const result = pageResult(found, cursor, requestedLimit, { repository: repo.alias, path: target.relative, denied_count: denied, visited, traversal_truncated: queue.length > 0 || visited >= this.config.limits.maxVisited });
    audit("fs_find", repo.alias, target.relative, result.truncated ? "truncated" : "ok", result.entries.length);
    return result;
  }

  async searchContent(args) {
    const repo = await this.repository(args.repository);
    const target = await this.resolvePath(repo, args.path || "", "directory");
    const requestedLimit = boundedInt(args.max_matches, "max_matches", 1, this.config.limits.maxMatches, this.config.limits.maxMatches);
    const cursor = parseCursor(args.cursor);
    const needle = args.query.toLocaleLowerCase();
    const matches = [];
    const queue = [{ absolute: target.absolute, relative: target.relative, depth: 0 }];
    let visited = 0;
    let denied = 0;
    while (queue.length && visited < this.config.limits.maxVisited && matches.length < cursor + requestedLimit + 1) {
      const current = queue.shift();
      const children = await readDirectory(current.absolute, repo.root);
      for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
        visited += 1;
        const relative = joinRelative(current.relative, entry.name);
        if (entry.isSymbolicLink()) throw new BridgeError("path_denied", "Symlinks and reparse points are not allowed in a content search.");
        if (isSecretPath(relative)) {
          denied += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (current.depth < this.config.limits.maxDepth) queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const file = await readBoundedText(path.join(current.absolute, entry.name), this.config.limits.maxFileBytes);
        if (file.binary || file.truncated || containsSecret(file.text)) {
          if (containsSecret(file.text)) denied += 1;
          continue;
        }
        const lines = file.text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLocaleLowerCase().includes(needle)) continue;
          const snippet = lines[index].slice(0, 240);
          if (containsSecret(snippet)) {
            denied += 1;
            continue;
          }
          matches.push({ path: relative, line: index + 1, text: snippet });
          if (matches.length >= cursor + requestedLimit + 1) break;
        }
        if (visited >= this.config.limits.maxVisited || matches.length >= cursor + requestedLimit + 1) break;
      }
    }
    const result = pageResult(matches, cursor, requestedLimit, { repository: repo.alias, path: target.relative, denied_count: denied, visited, traversal_truncated: queue.length > 0 || visited >= this.config.limits.maxVisited });
    audit("fs_search_content", repo.alias, target.relative, result.truncated ? "truncated" : "ok", result.entries.length);
    const { entries, ...rest } = result;
    return { ...rest, redacted: denied > 0, matches: entries };
  }

  async gitStatus(args) {
    const repo = await this.repository(args.repository);
    await this.assertGitSafe(repo);
    const status = await this.runGit(repo, ["status", "--short", "--branch", "-z", "--untracked-files=all", "--no-renames"], { maxBytes: this.config.limits.maxGitOutputBytes });
    if (status.truncated) throw new BridgeError("output_limit", "Git status exceeded the response budget.");
    const tokens = status.stdout.split("\0").filter(Boolean);
    const branch = tokens.shift()?.replace(/^##\s*/u, "") || null;
    if (containsSecret(branch || "")) throw new BridgeError("secret_denied", "Git metadata contains protected content.");
    const allEntries = [];
    let denied = 0;
    for (const token of tokens) {
      const code = token.slice(0, 2);
      const candidate = token.slice(3).replaceAll("\\", "/");
      let relative;
      try {
        relative = await this.validateGitPath(repo, candidate);
      } catch {
        denied += 1;
        continue;
      }
      if (isSecretPath(relative)) {
        denied += 1;
        continue;
      }
      allEntries.push({ status: code, path: relative });
    }
    const headSha = await this.gitHead(repo);
    const requestedLimit = boundedInt(args.max_entries, "max_entries", 1, this.config.limits.maxEntries, this.config.limits.maxEntries);
    const page = pageResult(allEntries, parseCursor(args.cursor), requestedLimit, { repository: repo.alias, branch, head_sha: headSha, denied_count: denied });
    audit("git_status", repo.alias, "", page.truncated ? "truncated" : "ok", page.entries.length);
    return { ...page, entries: page.entries };
  }

  async gitHeadInfo(args) {
    const repo = await this.repository(args.repository);
    const headSha = await this.gitHead(repo);
    const branch = await this.runGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"], { maxBytes: 256, allowNonZero: true });
    const branchName = branch.code === 0 ? branch.stdout.trim() : null;
    if (containsSecret(branchName || "")) throw new BridgeError("secret_denied", "Git metadata contains protected content.");
    audit("git_head", repo.alias, "", "ok", headSha ? 1 : 0);
    return { repository: repo.alias, head_sha: headSha, branch: branchName };
  }

  async gitRef(args) {
    const repo = await this.repository(args.repository);
    const revision = validateSha(args.revision_sha);
    const result = await this.runGit(repo, ["cat-file", "-e", `${revision}^{commit}`], { maxBytes: 128, allowNonZero: true });
    if (result.code !== 0) throw new BridgeError("git_ref_not_found", "The immutable revision was not found.");
    audit("git_ref", repo.alias, "", "ok", 1);
    return { repository: repo.alias, revision_sha: revision, exists: true };
  }

  async gitDiff(args, staged) {
    const repo = await this.repository(args.repository);
    await this.assertGitSafe(repo);
    const relative = args.path === undefined ? undefined : await this.validateGitPath(repo, args.path);
    if (relative !== undefined && isSecretPath(relative)) throw new BridgeError("secret_denied", "The requested path is protected.");
    await this.ensureUnscopedDiffSafe(repo, relative);
    const gitArgs = this.diffArguments(args, staged, null, relative);
    return await this.readDiffPage(repo, args, gitArgs, { kind: staged ? "staged" : "unstaged", staged, reference: null, path: relative, tool: staged ? "git_diff_staged" : "git_diff_unstaged" });
  }

  async gitDiffReference(args) {
    const repo = await this.repository(args.repository);
    await this.assertGitSafe(repo);
    const reference = validateSha(args.reference_sha);
    await this.gitRef({ repository: repo.alias, revision_sha: reference });
    const relative = args.path === undefined ? undefined : await this.validateGitPath(repo, args.path);
    if (relative !== undefined && isSecretPath(relative)) throw new BridgeError("secret_denied", "The requested path is protected.");
    await this.ensureUnscopedDiffSafe(repo, relative);
    const gitArgs = this.diffArguments(args, false, reference, relative);
    return await this.readDiffPage(repo, args, gitArgs, { kind: "reference", staged: false, reference, path: relative, tool: "git_diff" });
  }

  async ensureUnscopedDiffSafe(repo, relative) {
    if (relative !== undefined) return;
    const status = await this.gitStatus({ repository: repo.alias, max_entries: this.config.limits.maxEntries });
    if (status.truncated) throw new BridgeError("output_limit", "Unscoped Git diff requires a complete bounded status.");
    if (status.denied_count > 0) throw new BridgeError("secret_denied", "Unscoped Git diff includes a protected path.");
  }

  diffArguments(args, staged, reference, relative) {
    const context = boundedInt(args.context_lines, "context_lines", 0, 50, 3);
    const gitArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", `--unified=${context}`];
    if (staged) gitArgs.push("--cached");
    if (reference) gitArgs.push(reference);
    gitArgs.push("--");
    if (relative) gitArgs.push(relative);
    return gitArgs;
  }

  async readDiffPage(repo, args, gitArgs, state) {
    const contentBudget = Math.max(1, this.config.limits.maxResponseBytes - 2_048);
    const maxBytes = boundedInt(args.max_bytes, "max_bytes", 1, Math.min(this.config.limits.maxGitOutputBytes, contentBudget), Math.min(this.config.limits.maxGitOutputBytes, contentBudget));
    const result = await this.runGit(repo, gitArgs, { maxBytes: this.config.limits.maxDiffBytes + 1, allowTruncated: true });
    if (result.truncated) throw new BridgeError("output_limit", "The complete diff exceeds the configured scan limit; narrow the path or reduce the change.");
    if (containsSecretPathInDiff(result.stdout) || containsSecret(result.stdout)) throw new BridgeError("secret_denied", "The diff contains protected content.");
    const bytes = Buffer.from(result.stdout, "utf8");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const cursor = decodeDiffCursor(args.cursor);
    if (cursor && !sameDiffCursor(cursor, repo, state, digest)) throw new BridgeError("cursor_stale", "Cursor does not match the current diff.");
    const offset = cursor?.offset ?? 0;
    if (offset > bytes.length) throw new BridgeError("cursor_stale", "Cursor is outside the current diff.");
    const pageBytes = safeUtf8Prefix(bytes.subarray(offset), maxBytes);
    if (bytes.length > offset && pageBytes === 0) throw new BridgeError("output_limit", "max_bytes is too small for the next UTF-8 character.");
    const page = bytes.subarray(offset, offset + pageBytes);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < bytes.length;
    const nextCursor = truncated ? encodeDiffCursor({ ...state, root: repo.rootIdentity, repository: repo.alias, digest, offset: nextOffset }) : null;
    audit(state.tool, repo.alias, state.path || "", truncated ? "truncated" : "ok", page.length);
    return {
      repository: repo.alias,
      path: state.path || null,
      reference_sha: state.reference,
      diff: page.toString("utf8"),
      bytes: page.length,
      truncated,
      next_cursor: nextCursor,
      helper_flags: ["--no-ext-diff", "--no-textconv"],
    };
  }

  async gitLog(args) {
    const repo = await this.repository(args.repository);
    const revision = args.revision_sha === undefined ? "HEAD" : validateSha(args.revision_sha);
    const relative = args.path === undefined ? undefined : await this.validateGitPath(repo, args.path);
    if (relative !== undefined && isSecretPath(relative)) throw new BridgeError("secret_denied", "The requested path is protected.");
    const maxCount = boundedInt(args.max_count, "max_count", 1, this.config.limits.maxEntries, Math.min(50, this.config.limits.maxEntries));
    const skip = parseCursor(args.cursor);
    const gitArgs = ["log", "--no-color", "--no-decorate", `--max-count=${maxCount + 1}`, `--skip=${skip}`, "--format=%H%x00%aI%x00%an%x00%s%x00", revision, "--"];
    if (relative) gitArgs.push(relative);
    const result = await this.runGit(repo, gitArgs, { maxBytes: Math.min(this.config.limits.maxGitOutputBytes, Math.max(1, this.config.limits.maxResponseBytes - 2_048)) });
    if (result.truncated) throw new BridgeError("output_limit", "Git history exceeded the response budget.");
    const fields = result.stdout.split("\0").filter((field) => field.length > 0);
    const records = [];
    for (let index = 0; index + 3 < fields.length; index += 4) records.push(fields.slice(index, index + 4));
    const commits = [];
    let redacted = 0;
    let parsedSecret = false;
    for (const [index, record] of records.entries()) {
      if (record.some((field) => containsSecret(field))) {
        parsedSecret = true;
        if (index < maxCount) redacted += 1;
        continue;
      }
      if (index < maxCount) commits.push({ sha: record[0], authored_at: record[1], author: record[2], subject: record[3] });
    }
    if (containsSecret(result.stdout) && !parsedSecret) throw new BridgeError("secret_denied", "Git history contains an unclassified protected field.");
    const truncated = records.length > maxCount;
    const page = { repository: repo.alias, revision_sha: revision === "HEAD" ? await this.gitHead(repo) : revision, path: relative || null, commits, redacted, truncated, next_cursor: truncated ? String(skip + maxCount) : null };
    audit("git_log", repo.alias, relative || "", truncated ? "truncated" : "ok", commits.length);
    return page;
  }

  async gitHead(repo) {
    const result = await this.runGit(repo, ["rev-parse", "--verify", "HEAD"], { maxBytes: 200 });
    const sha = result.stdout.trim();
    return SHA_RE.test(sha) ? sha.toLowerCase() : null;
  }

  async assertGitSafe(repo) {
    const hazards = await this.runGit(repo, ["config", "--local", "--name-only", "--get-regexp", "^(filter\\.|diff\\..+\\.(command|textconv)|core\\.fsmonitor|include\\.)"], { maxBytes: 8 * 1024, allowNonZero: true });
    if (hazards.truncated || hazards.stdout.trim()) throw new BridgeError("git_helpers_blocked", "Repository Git helpers or includes require review before reading.");
  }

  async validateGitPath(repo, value) {
    const relative = normalizeRelativePath(value, true);
    if (!relative || isSecretPath(relative)) throw new BridgeError("secret_denied", "The requested path is protected.");
    const absolute = path.resolve(repo.root, ...relative.split("/"));
    await rejectReparseSegments(absolute, repo.root);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new BridgeError("path_denied", "Symbolic links and reparse points are not allowed.");
      if (stat.isFile() && stat.nlink > 1) throw new BridgeError("hardlink_denied", "Hard-linked files are not allowed.");
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error?.code !== "ENOENT") throw new BridgeError("path_denied", "Path cannot be inspected safely.");
    }
    return relative;
  }

  async captureBaseline(args = {}) {
    const repo = await this.repository(args.repository);
    const status = await this.gitStatus({ repository: repo.alias, max_entries: this.config.limits.maxEntries });
    if (status.truncated) throw new BridgeError("output_limit", "Baseline requires a complete bounded Git status.");
    const index = await this.gitIndexFingerprint(repo);
    const refs = await this.runGit(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"], { maxBytes: this.config.limits.maxGitOutputBytes });
    if (containsSecret(refs.stdout)) throw new BridgeError("secret_denied", "Git references contain protected content.");
    if (refs.truncated) throw new BridgeError("output_limit", "Git references exceeded the response budget.");
    const refHash = crypto.createHash("sha256").update(refs.stdout).digest("hex");
    const digest = crypto.createHash("sha256");
    const queue = [{ absolute: repo.root, relative: "", depth: 0 }];
    let files = 0;
    let bytes = 0;
    let skipped = 0;
    let truncated = false;
    while (queue.length && files < this.config.limits.maxBaselineFiles && bytes < this.config.limits.maxBaselineBytes) {
      const current = queue.shift();
      for (const entry of (await readDirectory(current.absolute, repo.root)).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = joinRelative(current.relative, entry.name);
        if (relative === ".git" || relative.startsWith(".git/")) continue;
        if (isSecretPath(relative) || entry.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (current.depth < this.config.limits.maxDepth) queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const file = await readBoundedText(path.join(current.absolute, entry.name), this.config.limits.maxFileBytes);
        if (file.binary || file.truncated || containsSecret(file.text)) {
          skipped += 1;
          truncated ||= file.truncated;
          continue;
        }
        const content = Buffer.from(file.text, "utf8");
        digest.update(relative);
        digest.update("\0");
        digest.update(content);
        digest.update("\0");
        files += 1;
        bytes += content.length;
        if (files >= this.config.limits.maxBaselineFiles || bytes >= this.config.limits.maxBaselineBytes) {
          truncated = true;
          break;
        }
      }
    }
    truncated ||= queue.length > 0;
    audit("baseline", repo.alias, "", truncated ? "truncated" : "ok", files);
    return {
      captured_at: new Date().toISOString(),
      repository: repo.alias,
      worktree: { identity: repo.rootIdentity, root: "configured" },
      worktree_identity: repo.rootIdentity,
      git: {
        head_sha: status.head_sha,
        branch: status.branch,
        status: { entries: status.entries, denied_count: status.denied_count, truncated: status.truncated },
        status_entries: status.entries.length,
        refs_sha256: refHash,
        index,
        index_sha256: index.sha256,
        index_bytes: index.bytes,
      },
      content: { sha256: digest.digest("hex"), files, bytes, skipped, truncated },
      codebase_memory: { state: "closed", reason: "Codebase Memory is intentionally disabled in the base adapter." },
    };
  }

  async gitIndexFingerprint(repo) {
    const result = await this.runGit(repo, ["rev-parse", "--git-path", "index"], { maxBytes: 2_048 });
    if (result.truncated) throw new BridgeError("output_limit", "The Git index path exceeded the response budget.");
    const candidate = result.stdout.trim();
    if (!candidate || candidate.includes("\0")) throw new BridgeError("git_failed", "Git did not return a usable index path.");
    const absolute = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(repo.root, candidate);
    await rejectReparseSegments(absolute, path.parse(absolute).root);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") return { state: "missing", sha256: null, bytes: 0 };
      throw new BridgeError("path_denied", "The Git index cannot be inspected safely.");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new BridgeError("path_denied", "The Git index is not a stable regular file.");
    if (stat.size > this.config.limits.maxBaselineBytes) throw new BridgeError("output_limit", "The Git index exceeds the configured fingerprint limit.");
    const handle = await fs.open(absolute, "r");
    const digest = crypto.createHash("sha256");
    let offset = 0;
    try {
      assertSameIdentity(stat, await handle.stat());
      while (offset < stat.size) {
        const amount = Math.min(64 * 1024, stat.size - offset);
        const buffer = Buffer.alloc(amount);
        const { bytesRead } = await handle.read(buffer, 0, amount, offset);
        if (bytesRead === 0) throw new BridgeError("path_changed", "The Git index ended while it was being fingerprinted.");
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      assertSameIdentity(stat, await handle.stat());
    } finally {
      await handle.close();
    }
    return { state: "present", sha256: digest.digest("hex"), bytes: offset };
  }

  async doctor() {
    const repositories = [];
    for (const alias of Object.keys(this.config.repositories)) {
      try {
        const repo = await this.repository(alias);
        const version = await this.runGit(repo, ["--version"], { maxBytes: 200 });
        repositories.push({ repository: alias, root: "configured", git: version.stdout.trim(), status: "PASS" });
      } catch (error) {
        repositories.push({ repository: alias, status: "FAIL", code: safeErrorCode(error) });
      }
    }
    return {
      status: repositories.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
      tools: getToolDefinitions(this.config).map((tool) => tool.name),
      repositories,
      optional_integrations: this.optionalIntegrationStatus(),
      transport: "stdio",
    };
  }

  async resolvePath(repo, value, expected) {
    const relative = normalizeRelativePath(value, true);
    const absolute = path.resolve(repo.root, ...(relative ? relative.split("/") : []));
    const relativeCheck = path.relative(repo.root, absolute);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new BridgeError("path_denied", "Path escapes the configured repository.");
    await rejectReparseSegments(absolute, repo.root);
    let real;
    let stat;
    try {
      real = await fs.realpath(absolute);
      stat = await fs.lstat(real);
    } catch (error) {
      throw new BridgeError(error?.code === "ENOENT" ? "path_missing" : "path_denied", "Path is not available.");
    }
    if (stat.isSymbolicLink()) throw new BridgeError("path_denied", "Symbolic links and reparse points are not allowed.");
    if (stat.isFile() && stat.nlink > 1) throw new BridgeError("hardlink_denied", "Hard-linked files are not allowed.");
    await rejectReparseSegments(real, repo.root);
    const realRelative = path.relative(repo.root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new BridgeError("path_denied", "Path escapes the configured repository.");
    const normalized = realRelative.split(path.sep).filter(Boolean).join("/");
    if (expected === "file" && !stat.isFile()) throw new BridgeError("path_type", "A file was required.");
    if (expected === "directory" && !stat.isDirectory()) throw new BridgeError("path_type", "A directory was required.");
    if (expected === "any" && !stat.isFile() && !stat.isDirectory()) throw new BridgeError("path_type", "Only files and directories are supported.");
    if (isSecretPath(normalized)) throw new BridgeError("secret_denied", "The requested path is protected.");
    return { absolute: real, relative: normalized, stat };
  }

  async runGit(repo, args, options = {}) {
    const prefix = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.preloadIndex=false", "-c", "core.quotePath=false", "-c", `safe.directory=${repo.root}`, "--no-optional-locks", "--literal-pathspecs"];
    const result = await runProcess(this.config.gitBinary, [...prefix, ...args], {
      cwd: repo.root,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(repo.root) },
      timeoutMs: this.config.limits.timeoutMs,
      maxBytes: options.maxBytes ?? this.config.limits.maxGitOutputBytes,
    });
    if (result.timedOut) throw new BridgeError("timeout", "Git operation timed out.");
    if (result.code !== 0 && !(options.allowNonZero && result.code !== null)) throw new BridgeError("git_failed", "Git operation failed.", { exit_code: result.code });
    return result;
  }
}

function validateArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new BridgeError("invalid_arguments", "Tool arguments must be an object.");
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  const properties = definition.inputSchema.properties || {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new BridgeError("invalid_arguments", "Unknown tool argument.", { field: key });
  for (const required of definition.inputSchema.required || []) if (args[required] === undefined) throw new BridgeError("invalid_arguments", "Required tool argument is missing.", { field: required });
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (schema.type === "string" && (typeof value !== "string" || value.length < schema.minLength || value.length > schema.maxLength)) throw new BridgeError("invalid_arguments", "String argument is outside its bounds.", { field: key });
    if (schema.type === "integer" && (!Number.isSafeInteger(value) || value < schema.minimum)) throw new BridgeError("invalid_arguments", "Integer argument is outside its bounds.", { field: key });
    if (schema.pattern && (typeof value !== "string" || !new RegExp(schema.pattern, "u").test(value))) throw new BridgeError("invalid_arguments", "Argument format is not allowed.", { field: key });
  }
  return args;
}

function boundedInt(value, field, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BridgeError("invalid_arguments", "Integer argument exceeds the configured bound.", { field, min, max });
  return value;
}

function parseCursor(value) {
  if (value === undefined) return 0;
  if (!/^\d{1,8}$/u.test(value)) throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 100_000) throw new BridgeError("invalid_arguments", "Cursor is outside its bound.");
  return cursor;
}

function pageResult(items, cursor, limit, base) {
  const page = items.slice(cursor, cursor + limit + 1);
  const hasMore = page.length > limit;
  if (hasMore) page.pop();
  return { ...base, entries: page, truncated: hasMore, next_cursor: hasMore ? String(cursor + page.length) : null };
}

function validateSha(value) {
  if (!SHA_RE.test(value)) throw new BridgeError("invalid_arguments", "revision_sha must be a complete SHA-1.", { field: "revision_sha" });
  return value.toLowerCase();
}

function normalizeRelativePath(value, allowEmpty) {
  if (typeof value !== "string") throw new BridgeError("invalid_arguments", "Path must be text.");
  if (!value && allowEmpty) return "";
  if (!value || value.length > 240 || value.includes("\0") || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("\\") || value.includes(":")) throw new BridgeError("path_denied", "Only bounded slash-separated relative paths are accepted.");
  if (value !== value.normalize("NFC")) throw new BridgeError("path_denied", "Path must use canonical Unicode normalization.");
  if (value.startsWith("/") || value.startsWith("//")) throw new BridgeError("path_denied", "Absolute and UNC paths are not accepted.");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part) || RESERVED_WIN32_RE.test(part))) throw new BridgeError("path_denied", "Path contains an ambiguous or unsafe segment.");
  return parts.join("/");
}

async function canonicalRoot(configured) {
  await rejectReparseSegments(configured, path.parse(configured).root);
  let real;
  let stat;
  try {
    real = await fs.realpath(configured);
    stat = await fs.lstat(real);
  } catch {
    throw new BridgeError("repository_unavailable", "Configured repository is unavailable.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BridgeError("repository_denied", "Configured repository root is not a regular directory.");
  await rejectReparseSegments(real, path.parse(real).root);
  return real;
}

async function rejectReparseSegments(target, stopAt) {
  const absolute = path.resolve(target);
  const root = path.resolve(stopAt);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw new BridgeError("path_denied", "Path cannot be inspected safely.");
    }
    if (stat.isSymbolicLink()) throw new BridgeError("path_denied", "Symbolic links and reparse points are not allowed.");
  }
}

function joinRelative(parent, child) {
  return parent ? `${parent}/${child}` : child;
}

function isSecretPath(relative) {
  const parts = String(relative || "").split(/[\\/]/u).filter(Boolean);
  return parts.some((part) => part.toLowerCase() === ".git" || SECRET_NAME_RE.test(part) || SECRET_EXT_RE.test(part));
}

function containsSecret(text) {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function containsSecretPathInDiff(text) {
  for (const line of String(text).split(/\r?\n/u)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/u);
    if (match && (isSecretPath(match[1]) || isSecretPath(match[2]))) return true;
    const oldPath = line.match(/^--- a\/(.+)$/u);
    const newPath = line.match(/^\+\+\+ b\/(.+)$/u);
    if ((oldPath && isSecretPath(oldPath[1])) || (newPath && isSecretPath(newPath[1]))) return true;
  }
  return false;
}

function statToken(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "0";
}

function makeRootIdentity(root, stat) {
  return crypto.createHash("sha256").update(`${root}\0${statToken(stat.dev)}\0${statToken(stat.ino)}`).digest("hex");
}

function makeFileIdentity(stat, rootIdentity, hash, hashBytes) {
  return {
    root: rootIdentity,
    size: stat.size,
    dev: statToken(stat.dev),
    ino: statToken(stat.ino),
    mtime_ms: statToken(stat.mtimeMs),
    ctime_ms: statToken(stat.ctimeMs),
    hash,
    hash_bytes: hashBytes,
    hash_complete: hashBytes === stat.size,
  };
}

function sameFileIdentity(left, right) {
  return ["root", "size", "dev", "ino", "mtime_ms", "ctime_ms", "hash", "hash_bytes", "hash_complete"].every((field) => left?.[field] === right?.[field]);
}

function sameFileCursor(cursor, relativePath, observed) {
  return cursor?.path === relativePath && sameFileIdentity(cursor, observed);
}

async function observeFile(absolute, expected, rootIdentity, maxHashBytes) {
  const handle = await fs.open(absolute, "r");
  try {
    const before = await handle.stat();
    assertSameIdentity(expected, before);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new BridgeError("path_denied", "Only a stable regular file can be read.");
    const hashLimit = Math.min(before.size, maxHashBytes);
    const digest = crypto.createHash("sha256");
    let offset = 0;
    while (offset < hashLimit) {
      const amount = Math.min(64 * 1024, hashLimit - offset);
      const buffer = Buffer.alloc(amount);
      const { bytesRead } = await handle.read(buffer, 0, amount, offset);
      if (bytesRead === 0) throw new BridgeError("path_changed", "The file ended while its version was being observed.");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    assertSameIdentity(before, after);
    return makeFileIdentity(after, rootIdentity, digest.digest("hex"), offset);
  } finally {
    await handle.close();
  }
}

async function readLineRange(absolute, expected, relativePath, startLine, endLine, maxScanBytes, maxOutputBytes, cursor, cursorIdentity) {
  const handle = await fs.open(absolute, "r");
  let position = cursor?.offset ?? 0;
  let lineStart = cursor?.offset ?? 0;
  let lineNo = cursor?.line ?? 1;
  const resumeSkip = cursor?.skip ?? 0;
  let scanned = 0;
  let lineBuffer = Buffer.alloc(0);
  let output = Buffer.alloc(0);
  let truncated = false;
  let nextCursor = null;
  let done = false;
  let resultEndLine = startLine - 1;
  const maxLineBytes = Math.min(256 * 1024, maxScanBytes);
  try {
    assertSameIdentity(expected, await handle.stat());
    if (position > expected.size || position + resumeSkip > expected.size) throw new BridgeError("invalid_arguments", "Cursor is outside the file.");
    while (!done && scanned < maxScanBytes) {
      const amount = Math.min(64 * 1024, maxScanBytes - scanned);
      const chunk = Buffer.alloc(amount);
      const { bytesRead } = await handle.read(chunk, 0, amount, position);
      if (bytesRead === 0) {
        if (lineBuffer.length > 0) {
          const consumed = processLine(lineBuffer, false);
          lineBuffer = Buffer.alloc(0);
          done = consumed;
        }
        break;
      }
      scanned += bytesRead;
      position += bytesRead;
      lineBuffer = Buffer.concat([lineBuffer, chunk.subarray(0, bytesRead)]);
      if (lineBuffer.length > maxLineBytes) throw new BridgeError("line_limit", "A single line exceeds the safe scan limit.");
      while (!done) {
        const newline = lineBuffer.indexOf(0x0a);
        if (newline === -1) break;
        const line = lineBuffer.subarray(0, newline + 1);
        lineBuffer = lineBuffer.subarray(newline + 1);
        const consumed = processLine(line, true);
        lineStart += line.length;
        lineNo += 1;
        if (lineNo !== startLine) {
          // A cursor only skips bytes within its first line.
          lineStart = position - lineBuffer.length;
        }
        if (consumed) done = true;
        if (lineBuffer.length > maxLineBytes) throw new BridgeError("line_limit", "A single line exceeds the safe scan limit.");
      }
    }
    if (!done && scanned >= maxScanBytes && position < expected.size) {
      truncated = true;
      nextCursor = encodeReadCursor(lineNo, lineStart, 0, relativePath, cursorIdentity);
    }
  } finally {
    await handle.close();
  }
  if (!nextCursor && done && position < expected.size) {
    truncated = true;
    nextCursor = encodeReadCursor(lineNo, position - lineBuffer.length, 0, relativePath, cursorIdentity);
  }
  return { text: output.toString("utf8"), bytesScanned: scanned, endLine: resultEndLine >= startLine ? resultEndLine : lineNo, truncated, nextCursor };

  function processLine(line, complete) {
    const text = line.toString("utf8");
    if (line.includes(0)) throw new BridgeError("binary_denied", "Only UTF-8 text files are readable.");
    if (containsSecret(text)) throw new BridgeError("secret_denied", "The requested content is protected.");
    if (lineNo < startLine || lineNo > endLine) return lineNo > endLine;
    const skip = lineNo === startLine ? resumeSkip : 0;
    const selected = line.subarray(Math.min(skip, line.length));
    resultEndLine = lineNo;
    const remaining = maxOutputBytes - output.length;
    const prefixLength = safeUtf8Prefix(selected, remaining);
    if (prefixLength < selected.length) {
      if (prefixLength === 0) {
        truncated = true;
        nextCursor = encodeReadCursor(lineNo, lineStart, skip, relativePath, cursorIdentity);
        return true;
      }
      output = Buffer.concat([output, selected.subarray(0, prefixLength)]);
      truncated = true;
      nextCursor = encodeReadCursor(lineNo, lineStart, skip + prefixLength, relativePath, cursorIdentity);
      return true;
    }
    output = Buffer.concat([output, selected]);
    if (lineNo >= endLine) {
      if (complete && lineStart + line.length < expected.size) {
        truncated = true;
        nextCursor = encodeReadCursor(lineNo + 1, lineStart + line.length, 0, relativePath, cursorIdentity);
      }
      return true;
    }
    return false;
  }
}

function encodeReadCursor(line, offset, skip, relativePath, identity) {
  const payload = {
    v: 2,
    line,
    offset,
    skip,
    path: relativePath,
    root: identity.root,
    size: identity.size,
    dev: identity.dev,
    ino: identity.ino,
    mtime_ms: identity.mtime_ms,
    ctime_ms: identity.ctime_ms,
    hash: identity.hash,
    hash_bytes: identity.hash_bytes,
    hash_complete: identity.hash_complete,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", CURSOR_KEY).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeReadCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  let decoded;
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || parts.some((part) => !part)) throw new Error("bad cursor");
    const expected = crypto.createHmac("sha256", CURSOR_KEY).update(parts[0]).digest("base64url");
    const actualBytes = Buffer.from(parts[1], "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (actualBytes.toString("base64url") !== parts[1]) throw new Error("noncanonical signature");
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) throw new Error("bad signature");
    decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  }
  if (!decoded || decoded.v !== 2 || typeof decoded.path !== "string" || !/^[0-9a-f]{64}$/u.test(decoded.root || "") || !Number.isSafeInteger(decoded.line) || !Number.isSafeInteger(decoded.offset) || !Number.isSafeInteger(decoded.skip) || !Number.isSafeInteger(decoded.size) || !/^\d+$/u.test(decoded.dev || "") || !/^\d+$/u.test(decoded.ino || "") || typeof decoded.mtime_ms !== "string" || typeof decoded.ctime_ms !== "string" || !/^[0-9a-z.+-]{1,64}$/iu.test(decoded.mtime_ms) || !/^[0-9a-z.+-]{1,64}$/iu.test(decoded.ctime_ms) || !/^[0-9a-f]{64}$/u.test(decoded.hash || "") || !Number.isSafeInteger(decoded.hash_bytes) || typeof decoded.hash_complete !== "boolean" || decoded.line < 1 || decoded.offset < 0 || decoded.skip < 0 || decoded.size < 0 || decoded.hash_bytes < 0) {
    throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  }
  return decoded;
}

function encodeDiffCursor(state) {
  const payload = {
    v: 1,
    type: "git_diff",
    repository: state.repository,
    root: state.root,
    kind: state.kind,
    staged: state.staged,
    reference: state.reference,
    path: state.path ?? null,
    digest: state.digest,
    offset: state.offset,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", CURSOR_KEY).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeDiffCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  let decoded;
  try {
    const parts = value.split(".");
    if (parts.length !== 2 || parts.some((part) => !part)) throw new Error("bad cursor");
    const expected = crypto.createHmac("sha256", CURSOR_KEY).update(parts[0]).digest("base64url");
    const actualBytes = Buffer.from(parts[1], "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (actualBytes.toString("base64url") !== parts[1]) throw new Error("noncanonical signature");
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) throw new Error("bad signature");
    decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  }
  if (!decoded || decoded.v !== 1 || decoded.type !== "git_diff" || typeof decoded.repository !== "string" || !/^[0-9a-f]{64}$/u.test(decoded.root || "") || !["unstaged", "staged", "reference"].includes(decoded.kind) || typeof decoded.staged !== "boolean" || (decoded.reference !== null && !SHA_RE.test(decoded.reference || "")) || (decoded.path !== null && typeof decoded.path !== "string") || !/^[0-9a-f]{64}$/u.test(decoded.digest || "") || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
    throw new BridgeError("invalid_arguments", "Cursor is invalid.");
  }
  return decoded;
}

function sameDiffCursor(cursor, repo, state, digest) {
  return cursor.repository === repo.alias
    && cursor.root === repo.rootIdentity
    && cursor.kind === state.kind
    && cursor.staged === state.staged
    && cursor.reference === state.reference
    && cursor.path === (state.path ?? null)
    && cursor.digest === digest;
}

function safeUtf8Prefix(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer.length;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

async function readDirectory(absolute, root) {
  await rejectReparseSegments(absolute, root);
  let before;
  try {
    before = await fs.lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new BridgeError("path_denied", "Directory is not a regular directory.");
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("path_denied", "Directory cannot be inspected safely.");
  }
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  await rejectReparseSegments(absolute, root);
  const after = await fs.lstat(absolute);
  for (const field of ["dev", "ino", "mode"]) {
    if (before[field] !== undefined && after[field] !== undefined && before[field] !== after[field]) throw new BridgeError("path_changed", "Directory changed while it was being read.");
  }
  return entries;
}

async function readBoundedText(absolute, maxBytes) {
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch {
    return { text: "", binary: true, truncated: false };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { text: "", binary: true, truncated: false };
  if (stat.nlink > 1) return { text: "", binary: true, truncated: false };
  const file = await fs.open(absolute, "r");
  let bytesRead;
  let buffer;
  try {
    assertSameIdentity(stat, await file.stat());
    buffer = Buffer.alloc(maxBytes + 1);
    ({ bytesRead } = await file.read(buffer, 0, buffer.length, 0));
  } finally {
    await file.close();
  }
  const bytes = buffer.subarray(0, bytesRead);
  return { text: bytes.toString("utf8"), binary: bytes.includes(0), truncated: bytesRead > maxBytes || stat.size > maxBytes };
}

function assertSameIdentity(expected, actual) {
  if (actual.nlink > 1) throw new BridgeError("hardlink_denied", "Hard-linked files are not allowed.");
  for (const field of ["dev", "ino", "size", "mode", "mtimeMs", "ctimeMs"]) {
    if (expected?.[field] !== undefined && actual?.[field] !== undefined && expected[field] !== actual[field]) {
      throw new BridgeError("path_changed", "The path changed while it was being opened.");
    }
  }
}

async function runProcess(command, args, { cwd, env = process.env, timeoutMs, maxBytes }) {
  const safeEnv = sanitizedGitEnv(env);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: safeEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    let stderrBytes = 0;
    let timer;
    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        truncated = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), code, signal, truncated, timedOut, stderr_bytes: stderrBytes });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

function sanitizedGitEnv(source) {
  const env = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL", "GIT_CEILING_DIRECTORIES"]) {
    const actual = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual !== undefined) env[actual] = source[actual];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_EXTERNAL_DIFF = "";
  env.GIT_DIFF_OPTS = "";
  env.GIT_SSH_COMMAND = "";
  env.GIT_SSH = "";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  return env;
}

function audit(tool, repository, relative, result, count) {
  process.stderr.write(`${JSON.stringify({ event: "bridge_call", tool, repository, path: relative || undefined, result, count })}\n`);
}

function safeErrorCode(error) {
  return error instanceof BridgeError ? error.code : "internal_error";
}

export function toSafeError(error) {
  if (error instanceof BridgeError) return { code: error.code, message: error.message, details: error.details };
  if (error?.name === "OptionalBackendError" && typeof error.code === "string") return { code: error.code, message: error.message, details: error.details || {} };
  return { code: "internal_error", message: "Bridge operation failed.", details: {} };
}

export function hasSecret(text) {
  return containsSecret(text);
}

export async function verifyNoReparse(target) {
  if (!path.isAbsolute(target)) throw new BridgeError("path_denied", "Target must be absolute.");
  await rejectReparseSegments(target, path.parse(target).root);
  return true;
}
