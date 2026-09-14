import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const localAppData = path.isAbsolute(process.env.LOCALAPPDATA || "")
  ? process.env.LOCALAPPDATA
  : path.join(os.homedir(), "AppData", "Local");
const appData = path.isAbsolute(process.env.APPDATA || "")
  ? process.env.APPDATA
  : path.join(os.homedir(), "AppData", "Roaming");

export const DEFAULT_CBM_COMMAND = path.join(localAppData, "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe");
export const DEFAULT_CONTEXT_MODE_SERVER = path.join(appData, "npm", "node_modules", "context-mode", "server.bundle.mjs");

export function getKnownContextModeStorageRoots(environment = process.env) {
  const home = os.homedir();
  const candidates = [
    environment?.CONTEXT_MODE_DIR,
    typeof environment?.CODEX_HOME === "string" && path.isAbsolute(environment.CODEX_HOME)
      ? path.join(environment.CODEX_HOME, "context-mode")
      : null,
    path.join(home, ".context-mode"),
    path.join(home, ".codex", "context-mode"),
    path.join(home, ".claude", "context-mode"),
  ];
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    if (!roots.some((root) => samePath(root, normalized))) roots.push(normalized);
  }
  return roots;
}

export function isKnownContextModeStorageRoot(candidate, environment = process.env) {
  return typeof candidate === "string"
    && getKnownContextModeStorageRoots(environment).some((root) => samePath(root, candidate));
}

const MAX_QUERY_LENGTH = 160;
const MAX_RESULTS = 20;
const MAX_CONTEXT_FILES = 200;
const MAX_CONTEXT_BYTES = 64 * 1024 * 1024;

export class OptionalBackendError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OptionalBackendError";
    this.code = code;
    this.details = details;
  }
}

export function createOptionalBackends(config, { hasSecret = () => false, verifyNoReparse = async () => {} } = {}) {
  return Object.freeze({
    cbmStatus: (args = {}) => runForBinding(config, "codebaseMemory", args, (backend, selected) => cbmStatus(backend, config.limits, { hasSecret, verifyNoReparse }).then((result) => ({ ...result, repository: selected.repository }))),
    cbmSearch: (args = {}) => runForBinding(config, "codebaseMemory", args, (backend, selected) => cbmSearch(backend, config.limits, args, { hasSecret, verifyNoReparse }).then((result) => ({ ...result, repository: selected.repository }))),
    cbmTrace: (args = {}) => runForBinding(config, "codebaseMemory", args, (backend, selected) => cbmTrace(backend, config.limits, args, { hasSecret, verifyNoReparse }).then((result) => ({ ...result, repository: selected.repository }))),
    cbmSnippet: (args = {}) => runForBinding(config, "codebaseMemory", args, (backend, selected) => cbmSnippet(backend, config.limits, args, { hasSecret, verifyNoReparse }).then((result) => ({ ...result, repository: selected.repository }))),
    contextModeSearch: (args = {}, sessionIdentity = null) => runForBinding(config, "contextMode", args, (backend, selected) => contextModeSearch(backend, config.limits, args, { hasSecret, verifyNoReparse, sessionIdentity }).then((result) => ({ ...result, repository: selected.repository }))),
  });
}

function bindingEntries(config) {
  const backends = config?.optionalBackends || {};
  if (backends.bindings && typeof backends.bindings === "object" && !Array.isArray(backends.bindings)) return Object.entries(backends.bindings);
  const legacy = {};
  if (backends.codebaseMemory || backends.contextMode) legacy.fixture = { alias: "fixture", codebaseMemory: backends.codebaseMemory || null, contextMode: backends.contextMode || null };
  return Object.entries(legacy);
}

function selectBinding(config, kind, args) {
  const entries = bindingEntries(config).filter(([, binding]) => Boolean(binding?.[kind]));
  const requested = args?.repository;
  if (requested !== undefined) {
    if (typeof requested !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(requested) || (config.repositories && !config.repositories[requested])) {
      throw new OptionalBackendError("repository_denied", "Repository alias is not authorized.", { repository: requested });
    }
    const backend = entries.find(([alias]) => alias === requested)?.[1]?.[kind];
    if (!backend) throw new OptionalBackendError("repository_denied", "The requested repository has no binding for this optional backend.", { repository: requested });
    if (backend.ready === false) throw new OptionalBackendError("backend_unavailable", "The optional backend binding is not ready.", { repository: requested, reason: backend.unavailableReason || "discovery_unvalidated" });
    return { repository: requested, backend };
  }
  const ready = entries.filter(([, binding]) => binding[kind].ready !== false);
  if (entries.length > 1) throw new OptionalBackendError("repository_required", "Specify repository for the optional backend.");
  if (ready.length === 1) return { repository: ready[0][0], backend: ready[0][1][kind] };
  if (entries.length === 1) throw new OptionalBackendError("backend_unavailable", "The optional backend binding is not ready.", { repository: entries[0][0], reason: entries[0][1][kind].unavailableReason || "discovery_unvalidated" });
  throw new OptionalBackendError("backend_unavailable", "No repository binding is configured for the optional backend.");
}

async function runForBinding(config, kind, args, operation) {
  const selected = selectBinding(config, kind, args || {});
  return await operation(selected.backend, selected);
}

async function cbmStatus(config, limits, guards) {
  requireConfigured(config, "codebase_memory");
  const rootBefore = await verifyCbmRoot(config, guards);
  return await withClient(config, "codescope-cbm", async (client) => {
    const context = await readCbmContext(client, config, guards, rootBefore);
    return {
      backend: "codebase-memory",
      project: config.project,
      root_path: context.rootPath,
      root_verified: true,
      server: client.getServerVersion() || null,
      index: {
        status: context.index.status || null,
        nodes: safeInteger(context.index.nodes),
        edges: safeInteger(context.index.edges),
        branch: safeText(context.index.git?.branch),
        head_sha: safeSha(context.index.git?.head_sha),
      },
      freshness: context.freshness,
    };
  }, limits);
}

async function cbmSearch(config, limits, args, guards) {
  requireConfigured(config, "codebase_memory");
  const query = boundedQuery(args?.query, "query", guards.hasSecret);
  const limit = boundedLimit(args?.limit, "limit");
  const offset = boundedOffset(args?.offset);
  const rootBefore = await verifyCbmRoot(config, guards);
  return await withClient(config, "codescope-cbm", async (client) => {
    const context = await readCbmContext(client, config, guards, rootBefore);
    const result = await callTool(client, "search_graph", {
      project: config.project,
      query,
      format: "json",
      limit,
      offset,
      fields: ["signature", "return_type"],
    });
    assertNoSecrets(result, guards.hasSecret);
    await verifyCbmRoot(config, guards, rootBefore);
    return {
      backend: "codebase-memory",
      project: config.project,
      root_path: context.rootPath,
      root_verified: true,
      freshness: context.freshness,
      query,
      ...filterSearch(result, config),
    };
  }, limits);
}

async function cbmTrace(config, limits, args, guards) {
  requireConfigured(config, "codebase_memory");
  const functionName = boundedQualifiedName(args?.function_name, "function_name", config.project, guards.hasSecret);
  const depth = boundedInt(args?.depth, "depth", 1, 2, 1);
  const limit = boundedLimit(args?.limit, "limit");
  const direction = args?.direction ?? "both";
  if (!["inbound", "outbound", "both"].includes(direction)) throw new OptionalBackendError("invalid_arguments", "Trace direction is not allowed.", { field: "direction" });
  if (!isAllowedQualifiedName(functionName, config)) throw new OptionalBackendError("project_boundary", "Qualified name is outside the authorized source scope.", { field: "function_name" });
  const rootBefore = await verifyCbmRoot(config, guards);
  return await withClient(config, "codescope-cbm", async (client) => {
    const context = await readCbmContext(client, config, guards, rootBefore);
    const result = await callTool(client, "trace_path", {
      project: config.project,
      function_name: functionName,
      direction,
      depth,
      mode: "calls",
      limit,
      format: "json",
      include_evidence: true,
    });
    assertNoSecrets(result, guards.hasSecret);
    await verifyCbmRoot(config, guards, rootBefore);
    return {
      backend: "codebase-memory",
      project: config.project,
      root_path: context.rootPath,
      root_verified: true,
      freshness: context.freshness,
      function_name: functionName,
      ...filterTrace(result, config),
    };
  }, limits);
}

async function cbmSnippet(config, limits, args, guards) {
  requireConfigured(config, "codebase_memory");
  const qualifiedName = boundedQualifiedName(args?.qualified_name, "qualified_name", config.project, guards.hasSecret);
  if (!isAllowedQualifiedName(qualifiedName, config)) throw new OptionalBackendError("project_boundary", "Qualified name is outside the authorized source scope.", { field: "qualified_name" });
  const rootBefore = await verifyCbmRoot(config, guards);
  return await withClient(config, "codescope-cbm", async (client) => {
    const context = await readCbmContext(client, config, guards, rootBefore);
    const result = await callTool(client, "get_code_snippet", {
      project: config.project,
      qualified_name: qualifiedName,
      include_neighbors: true,
    });
    assertNoSecrets(result, guards.hasSecret);
    await verifyCbmRoot(config, guards, rootBefore);
    return {
      backend: "codebase-memory",
      project: config.project,
      root_path: context.rootPath,
      root_verified: true,
      freshness: context.freshness,
    ...filterSnippet(result, config, guards, qualifiedName),
    };
  }, limits);
}

async function contextModeSearch(config, limits, args, guards) {
  requireConfigured(config, "context_mode");
  const query = boundedQuery(args?.query, "query", guards.hasSecret);
  const limit = boundedLimit(args?.limit, "limit", 3);
  const sessionId = guards.sessionIdentity || config.sessionId || null;
  const scope = await verifyContextScope(config, guards);
  const before = await snapshotFiles(config.storage, config.storageFiles, guards.verifyNoReparse);
  const isolated = await cloneContextStorage(config.storage, config.storageFiles, guards.verifyNoReparse);
  let result;
  try {
    result = await withClient({ ...config, env: {
      ...config.env,
      CONTEXT_MODE_DIR: isolated.storage,
      CONTEXT_MODE_DATA_DIR: path.join(isolated.home, "context-data"),
      CODEX_HOME: path.join(isolated.home, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(isolated.home, ".claude"),
      HOME: isolated.home,
      USERPROFILE: isolated.home,
      APPDATA: path.join(isolated.home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(isolated.home, "AppData", "Local"),
      CLAUDE_SESSION_ID: sessionId || undefined,
    } }, "codescope-context-mode", async (client) => await callTool(client, "ctx_search", {
      queries: [query],
      ...(config.source ? { source: config.source } : {}),
      limit,
      contentType: "prose",
      sort: config.queryMode || "relevance",
    }), limits);
  } finally {
    await fs.rm(isolated.root, { recursive: true, force: true });
  }
  const after = await snapshotFiles(config.storage, config.storageFiles, guards.verifyNoReparse);
  const scopeAfter = await verifyContextScope(config, guards, scope);
  if (!sameSnapshot(before, after)) throw new OptionalBackendError("backend_mutated", "Context Mode changed its authorized read-only corpus.");
  const afterCorpus = [];
  for (const entry of scope.corpus) {
    const current = scopeAfter.corpus.find((candidate) => candidate.path === entry.path);
    if (!current) throw new OptionalBackendError("scope_changed", "Context Mode corpus scope changed.");
    afterCorpus.push({ ...entry, after_sha256: current.before_sha256, after_bytes: current.bytes });
  }
  if (afterCorpus.some((entry) => entry.before_sha256 !== entry.after_sha256 || entry.bytes !== entry.after_bytes)) {
    throw new OptionalBackendError("backend_mutated", "Context Mode changed the authorized corpus.");
  }
  const text = textOf(result);
  const matches = filterContextText(text, config.source, guards.hasSecret);
  return {
    backend: "context-mode",
    scope: config.scope || "bound",
    project: config.project || path.basename(config.projectRoot),
    project_root_verified: scope.projectRootVerified,
    storage_root_verified: scope.storageRootVerified,
    source: config.source,
    query,
    matches,
    session_id: guards.sessionIdentity ? null : config.sessionId,
    session_identity: guards.sessionIdentity ? "conversation" : config.sessionId ? "configured_session_id" : "unconfigured",
    session_fingerprint: sessionId ? crypto.createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 16) : "unavailable",
    corpus: afterCorpus,
    integrity: {
      corpus_unchanged: afterCorpus.every((entry) => entry.before_sha256 === entry.after_sha256),
      storage_unchanged: true,
      query_storage_isolated: true,
      session_events_isolated: true,
    },
  };
}

async function cloneContextStorage(source, allowedFiles, verifyNoReparse = async () => {}) {
  // ponytail: the native ctx_search updates session stats; an ephemeral copy is the smallest read-only boundary.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codescope-context-readonly-"));
  const storage = path.join(root, "storage-session");
  const home = path.join(root, "home");
  try {
    await fs.mkdir(home, { recursive: true });
    for (const relative of allowedFiles) {
      const sourceFile = path.resolve(source, ...relative.split("/"));
      if (!isWithin(source, sourceFile)) throw new OptionalBackendError("scope_denied", "Context Mode storage file escapes the authorized storage root.");
      await verifyNoReparse(sourceFile);
      const original = await fileHash(sourceFile);
      const target = path.join(storage, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(sourceFile, target);
      const sourceAfterCopy = await fileHash(sourceFile);
      const copied = await fileHash(target);
      if (original.sha256 !== sourceAfterCopy.sha256 || original.bytes !== sourceAfterCopy.bytes || original.identity !== sourceAfterCopy.identity || original.sha256 !== copied.sha256 || original.bytes !== copied.bytes) {
        throw new OptionalBackendError("scope_changed", "Context Mode storage could not be copied with stable identity.");
      }
    }
    return { root, storage, home };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    if (error instanceof OptionalBackendError) throw error;
    throw new OptionalBackendError("backend_unavailable", "Context Mode read-only storage could not be prepared.", { cause: error?.code || "copy_failed" });
  }
}

async function readCbmContext(client, config, guards, rootBefore) {
  const rootCheck = await verifyCbmRoot(config, guards, rootBefore);
  const projects = await callTool(client, "list_projects", { include_details: true, limit: 50, offset: 0 });
  assertNoSecrets(projects, guards.hasSecret);
  const rows = Array.isArray(projects?.projects) ? projects.projects : [];
  if (projects?.has_more !== false) throw new OptionalBackendError("backend_contract", "Codebase Memory project listing did not provide a bounded completion marker.");
  const matches = rows.filter((row) => row?.name === config.project && samePath(row?.root_path, config.root));
  if (matches.length !== 1) throw new OptionalBackendError("backend_contract", "Codebase Memory did not return the authorized project exactly once.");
  const index = await callTool(client, "index_status", { project: config.project, verbose: true });
  assertNoSecrets(index, guards.hasSecret);
  if (index?.project !== config.project || !samePath(index?.root_path, config.root)) {
    throw new OptionalBackendError("backend_contract", "Codebase Memory index identity does not match the authorized root.");
  }
  const coverage = await callTool(client, "check_index_coverage", { project: config.project, paths: config.allowedPaths });
  assertNoSecrets(coverage, guards.hasSecret);
  const paths = Array.isArray(coverage?.paths) ? coverage.paths : [];
  const freshness = {
    signal: coverage?.signal || "unknown",
    indexed_at: coverage?.indexed_at || null,
    generation: coverage?.metadata?.generation || null,
    generation_matches: coverage?.metadata?.generation_matches === true,
    paths: paths
      .filter((entry) => config.allowedPaths.includes(entry?.path || entry?.requested_path))
      .map((entry) => ({
        path: entry.path || entry.requested_path,
        status: entry.status || "unknown",
        observed: entry.freshness || "unknown",
        usable: entry.freshness === "fresh",
        recommended_action: entry.recommended_action || null,
      })),
  };
  await verifyCbmRoot(config, guards, rootBefore);
  return { rootPath: rootCheck.root, index, coverage, freshness };
}

async function verifyCbmRoot(config, guards, expected) {
  await guards.verifyNoReparse(config.root);
  const root = await fs.realpath(config.root).catch(() => { throw new OptionalBackendError("scope_changed", "Codebase Memory root is unavailable."); });
  if (!samePath(root, config.root)) throw new OptionalBackendError("scope_changed", "Codebase Memory root identity changed.");
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch {
    throw new OptionalBackendError("scope_changed", "Codebase Memory root is unavailable.");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new OptionalBackendError("scope_denied", "Codebase Memory root is not a stable directory.");
  const identity = directoryIdentity(rootStat);
  if (expected && (expected.root !== root || expected.identity !== identity)) throw new OptionalBackendError("scope_changed", "Codebase Memory root identity changed during the request.");
  return { root, identity };
}

function filterSearch(result, config) {
  if (Array.isArray(result?.rows)) {
    const columns = new Map((result.cols || []).map((name, index) => [name, index]));
    const rows = result.rows
      .filter((row) => {
        const qualifiedName = row?.[columns.get("qn")];
        const relative = row?.[columns.get("file")];
        return typeof qualifiedName === "string" && typeof relative === "string" && config.allowedPaths.includes(relative) && isAllowedQualifiedName(qualifiedName, config);
      })
      .slice(0, MAX_RESULTS)
      .map((row) => {
        const qualifiedName = row[columns.get("qn")];
        const name = qualifiedName.split(".").at(-1);
        return [qualifiedName, name, row[columns.get("label")] ?? null, row[columns.get("file")] ?? null, row[columns.get("lines")] ?? null, Number.isFinite(row[columns.get("rank")]) ? row[columns.get("rank")] : null];
      });
    return { total: rows.length, count: rows.length, cols: ["qualified_name", "name", "label", "path", "lines", "rank"], rows, truncated: result.has_more === true };
  }
  const groups = compactGroups(result?.groups, config, ["name", "label", "lines", "in", "out", "signature", "return_type"]);
  return { total: groups.reduce((count, group) => count + group.rows.length, 0), count: groups.reduce((count, group) => count + group.rows.length, 0), cols: ["name", "label", "lines", "in", "out", "signature", "return_type"], groups, truncated: result?.has_more === true };
}

function filterTrace(result, config) {
  return {
    direction: safeText(result?.direction),
    mode: safeText(result?.mode),
    callees: compactTrace(result?.callees, config),
    callers: compactTrace(result?.callers, config),
    callees_total: safeInteger(result?.callees_total),
    callers_total: safeInteger(result?.callers_total),
  };
}

function filterSnippet(result, config, guards, requestedName) {
  const relative = safeRelativePath(result?.file_path, config.root);
  if (!config.allowedPaths.includes(relative)) throw new OptionalBackendError("project_boundary", "Codebase Memory returned a path outside the authorized source allowlist.");
  if (result?.qualified_name !== requestedName) throw new OptionalBackendError("backend_contract", "Codebase Memory returned a different qualified symbol than requested.");
  if (typeof result?.source !== "string" || guards.hasSecret(result.source)) throw new OptionalBackendError("secret_denied", "Codebase Memory returned protected source content.");
  return {
    name: safeText(result.name),
    qualified_name: safeText(result.qualified_name),
    label: safeText(result.label),
    path: relative,
    start_line: safeInteger(result.start_line),
    end_line: safeInteger(result.end_line),
    source: result.source,
    callers: safeInteger(result.callers),
    callees: safeInteger(result.callees),
    callee_names: Array.isArray(result.callee_names) ? result.callee_names.filter((value) => typeof value === "string" && !guards.hasSecret(value)).slice(0, MAX_RESULTS) : [],
  };
}

function compactGroups(groups, config, columns) {
  if (!Array.isArray(groups)) throw new OptionalBackendError("backend_contract", "Codebase Memory returned no grouped result.");
  const allowed = new Set(config.allowedPaths);
  return groups
    .filter((group) => allowed.has(group?.file) && typeof group?.qn_prefix === "string" && isAllowedQualifiedPrefix(group.qn_prefix, config))
    .map((group) => ({
      qn_prefix: group.qn_prefix,
      file: group.file,
      rows: Array.isArray(group.rows) ? group.rows.slice(0, MAX_RESULTS).map((row) => columns.map((_, index) => row?.[index] ?? null)) : [],
    }))
    .filter((group) => group.rows.length > 0);
}

function compactTrace(section, config) {
  if (!section || !Array.isArray(section.groups)) return { cols: [], groups: [] };
  const groups = section.groups
    .filter((group) => typeof group?.qn_prefix === "string" && isAllowedQualifiedPrefix(group.qn_prefix, config))
    .map((group) => ({
      qn_prefix: group.qn_prefix,
      rows: Array.isArray(group.rows) ? group.rows.slice(0, MAX_RESULTS).map((row) => [row?.[0] ?? null, row?.[1] ?? null, row?.[2] ?? null, row?.[3] ?? null]) : [],
    }))
    .filter((group) => group.rows.length > 0);
  return { cols: ["name", "hop", "strategy", "confidence"], groups };
}

function isAllowedQualifiedName(value, config) {
  return config.allowedPaths.some((relative) => {
    const moduleName = relative.replace(/\.[^.]+$/u, "").replaceAll("/", ".");
    return value.startsWith(`${config.project}.${moduleName}.`);
  });
}

function isAllowedQualifiedPrefix(value, config) {
  return config.allowedPaths.some((relative) => {
    const moduleName = relative.replace(/\.[^.]+$/u, "").replaceAll("/", ".");
    return value === `${config.project}.${moduleName}` || value.startsWith(`${config.project}.${moduleName}.`);
  });
}

function assertNoSecrets(value, hasSecret) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new OptionalBackendError("backend_contract", "Optional backend returned an unreadable result."); }
  if (hasSecret(text)) throw new OptionalBackendError("secret_denied", "Optional backend returned protected content.");
}

async function verifyContextScope(config, guards, expected) {
  await guards.verifyNoReparse(config.projectRoot);
  await guards.verifyNoReparse(config.storage);
  let projectRoot;
  let storage;
  try {
    projectRoot = await fs.realpath(config.projectRoot);
    storage = await fs.realpath(config.storage);
  } catch {
    throw new OptionalBackendError("scope_changed", "Context Mode scope is unavailable.");
  }
  if (!samePath(projectRoot, config.projectRoot) || !samePath(storage, config.storage)) throw new OptionalBackendError("scope_changed", "Context Mode scope identity changed.");
  let projectRootStat;
  let storageStat;
  try {
    projectRootStat = await fs.lstat(projectRoot);
    storageStat = await fs.lstat(storage);
  } catch {
    throw new OptionalBackendError("scope_changed", "Context Mode scope is unavailable.");
  }
  if (!projectRootStat.isDirectory() || projectRootStat.isSymbolicLink() || !storageStat.isDirectory() || storageStat.isSymbolicLink()) throw new OptionalBackendError("scope_denied", "Context Mode scope is not a stable directory.");
  const projectRootIdentity = directoryIdentity(projectRootStat);
  const storageIdentity = directoryIdentity(storageStat);
  if (expected && (expected.projectRoot !== projectRoot || expected.storage !== storage || expected.projectRootIdentity !== projectRootIdentity || expected.storageIdentity !== storageIdentity)) {
    throw new OptionalBackendError("scope_changed", "Context Mode scope identity changed during the request.");
  }
  if (!isWithin(projectRoot, storage) && !config.storageRootKnown) {
    throw new OptionalBackendError("scope_denied", "Context Mode storage escapes the authorized project.");
  }
  const corpus = [];
  for (const relative of config.corpusPaths) {
    const absolute = path.resolve(projectRoot, ...relative.split("/"));
    if (!isWithin(projectRoot, absolute)) throw new OptionalBackendError("scope_denied", "Context Mode corpus path escapes the authorized project.");
    await guards.verifyNoReparse(absolute);
    const before = await fileHash(absolute);
    corpus.push({ path: relative, bytes: before.bytes, before_sha256: before.sha256, after_sha256: before.sha256 });
  }
  return { projectRoot, storage, projectRootIdentity, storageIdentity, projectRootVerified: true, storageRootVerified: true, corpus };
}

function directoryIdentity(stat) {
  return [statToken(stat.dev), statToken(stat.ino), statToken(stat.birthtimeMs), statToken(stat.mode)].join("\0");
}

function statToken(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "0";
}

async function snapshotFiles(root, allowedFiles, verifyNoReparse = async () => {}) {
  const rows = [];
  let bytes = 0;
  for (const relative of allowedFiles) {
    if (rows.length >= MAX_CONTEXT_FILES || bytes >= MAX_CONTEXT_BYTES) throw new OptionalBackendError("output_limit", "Context Mode storage exceeds the snapshot bound.");
    const absolute = path.resolve(root, ...relative.split("/"));
    if (!isWithin(root, absolute)) throw new OptionalBackendError("scope_denied", "Context Mode storage file escapes the authorized storage root.");
    await verifyNoReparse(absolute);
    const info = await fileHash(absolute);
    bytes += info.bytes;
    rows.push({ path: relative, bytes: info.bytes, sha256: info.sha256 });
  }
  return rows;
}

async function fileHash(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new OptionalBackendError("scope_denied", "Context Mode corpus is not a stable regular file.");
  if (stat.size > MAX_CONTEXT_BYTES) throw new OptionalBackendError("output_limit", "Context Mode corpus file exceeds the snapshot bound.");
  const bytes = await fs.readFile(file);
  return {
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    identity: [statToken(stat.dev), statToken(stat.ino), statToken(stat.birthtimeMs), statToken(stat.ctimeMs), statToken(stat.mode)].join("\0"),
  };
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function filterContextText(text, source, hasSecret) {
  if (hasSecret(text)) throw new OptionalBackendError("secret_denied", "Context Mode returned protected content.");
  const matches = [];
  for (const section of String(text).split(/(?=^--- \[)/mu)) {
    const header = section.match(/^--- \[([^\]]+)\] ---/mu);
    if (!header) continue;
    const fields = header[1].split("|").map((field) => field.trim());
    const actualSource = fields.at(-1) || null;
    if (source !== null && actualSource !== source) continue;
    const body = section.slice(header.index + header[0].length).trim();
    if (hasSecret(body)) throw new OptionalBackendError("secret_denied", "Context Mode returned protected content.");
    matches.push({ scope: fields[0] || null, timestamp: fields[1] || null, source: actualSource, text: body });
  }
  return matches.slice(0, MAX_RESULTS);
}

async function withClient(config, name, operation, limits) {
  const env = minimalEnvironment(config.env || {});
  const client = new Client({ name, version: "0.1.0" }, {});
  let transport;
  let timer;
  let run;
  try {
    transport = new StdioClientTransport({ command: config.command, args: config.args || [], cwd: config.cwd, env, stderr: "pipe" });
    run = (async () => {
      await client.connect(transport);
      const result = await operation(client);
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (bytes > (limits?.maxResponseBytes ?? 64 * 1024)) throw new OptionalBackendError("output_limit", "Optional backend result exceeds the response bound.");
      return result;
    })();
    run.catch(() => {});
    const timeoutMs = limits?.timeoutMs ?? 5_000;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new OptionalBackendError("timeout", "Optional backend request timed out.")), timeoutMs); });
    return await Promise.race([run, timeout]);
  } catch (error) {
    if (error instanceof OptionalBackendError) throw error;
    throw new OptionalBackendError("backend_unavailable", "Optional backend request failed.");
  } finally {
    if (timer) clearTimeout(timer);
    try { await client.close(); } catch {}
    try { await transport?.close(); } catch {}
  }
}

async function callTool(client, name, args) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch {
    throw new OptionalBackendError("backend_call_failed", "Optional backend rejected the read-only request.");
  }
  if (result?.isError) throw new OptionalBackendError("backend_call_failed", "Optional backend returned an error for the read-only request.");
  const structured = result?.structuredContent;
  if (structured !== undefined) return structured;
  const text = textOf(result);
  try { return JSON.parse(text); } catch { return { text }; }
}

function textOf(result) {
  if (typeof result?.text === "string") return result.text;
  return (result?.content || []).filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

function requireConfigured(config, name) {
  if (!config) throw new OptionalBackendError("backend_unavailable", `${name} backend is not configured for this repository.`);
  if (config.ready === false) throw new OptionalBackendError("backend_unavailable", `${name} backend is not ready for this repository.`, { reason: config.unavailableReason || "discovery_unvalidated" });
}

function boundedQuery(value, field, hasSecret) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_QUERY_LENGTH) throw new OptionalBackendError("invalid_arguments", "Query is outside its bound.", { field });
  if (hasSecret(value)) throw new OptionalBackendError("secret_denied", "Query contains protected content.", { field });
  return value;
}

function boundedQualifiedName(value, field, project, hasSecret) {
  const name = boundedQuery(value, field, hasSecret);
  if (!name.startsWith(`${project}.`) || /[^A-Za-z0-9_.:-]/u.test(name)) throw new OptionalBackendError("project_boundary", "Qualified name is outside the authorized project.", { field });
  return name;
}

function boundedLimit(value, field, fallback = 10) {
  return boundedInt(value, field, 1, MAX_RESULTS, fallback);
}

function boundedOffset(value) {
  return boundedInt(value, "offset", 0, 100, 0);
}

function boundedInt(value, field, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OptionalBackendError("invalid_arguments", "Integer argument is outside its bound.", { field, min, max });
  return value;
}

function safeText(value) {
  return typeof value === "string" ? value : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function safeSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : null;
}

function safeRelativePath(value, root) {
  if (typeof value !== "string") throw new OptionalBackendError("backend_contract", "Codebase Memory omitted the source path.");
  const relative = path.relative(root, value).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) throw new OptionalBackendError("project_boundary", "Codebase Memory returned a path outside the authorized root.");
  return relative;
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => path.normalize(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function minimalEnvironment(overrides) {
  const allowed = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "LANG", "LC_ALL"];
  const env = {};
  for (const key of allowed) {
    const actual = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual !== undefined) env[actual] = process.env[actual];
  }
  for (const [key, value] of Object.entries(overrides)) if (typeof value === "string") env[key] = value;
  return env;
}
