import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DISCOVERY_POLICY = Object.freeze({
  filesystem: "universal",
  git: "universal",
  optional: "opt_in",
});

const TARGETS = Object.freeze({
  ponytail: Object.freeze({
    root: "basePath",
    relative: path.posix.join("plugins", "cache", "ponytail", "ponytail"),
    expected: "directory",
    markers: Object.freeze([
      path.posix.join(".codex-plugin", "plugin.json"),
      "package.json",
      path.posix.join("ponytail-mcp", "package.json"),
      path.posix.join("ponytail-mcp", "index.js"),
    ]),
  }),
  codebase_memory: Object.freeze({
    root: "localAppData",
    relatives: Object.freeze([
      path.posix.join("Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe"),
      path.posix.join("Programs", "codebase-memory-mcp", "codebase-memory-mcp"),
    ]),
    expected: "file",
  }),
  context_mode: Object.freeze({
    root: "appData",
    relatives: Object.freeze([path.posix.join("npm", "node_modules", "context-mode", "server.bundle.mjs")]),
    candidates: Object.freeze([
      Object.freeze({
        root: "npmGlobalModules",
        relatives: Object.freeze([path.posix.join("context-mode", "server.bundle.mjs")]),
      }),
      Object.freeze({
        root: "appData",
        relatives: Object.freeze([path.posix.join("npm", "node_modules", "context-mode", "server.bundle.mjs")]),
      }),
    ]),
    expected: "file",
  }),
});

export const OPTIONAL_DISCOVERY_TARGETS = TARGETS;

const TARGET_ALIASES = Object.freeze({
  ponytail: Object.freeze(["ponytail"]),
  codebase_memory: Object.freeze(["codebase_memory", "codebaseMemory"]),
  context_mode: Object.freeze(["context_mode", "contextMode"]),
});

const ENV_ROOT_KEYS = Object.freeze({
  basePath: Object.freeze(["basePath", "base_path", "CODEX_HOME"]),
  localAppData: Object.freeze(["localAppData", "local_app_data", "LOCALAPPDATA"]),
  appData: Object.freeze(["appData", "app_data", "APPDATA"]),
});

const DISCOVERY_STATES = new Set(["disabled", "absent", "found", "validated", "unavailable"]);

/**
 * Inspect only the three known local optional integrations.
 *
 * `setting` accepts `true` or `{ enabled: true, integrations?: {...} }`.
 * `environment` supplies explicit roots: `basePath`, `localAppData`, and
 * `appData`; an `env` object is also accepted, but only the three matching
 * non-secret path variables above are read. A synchronous `fs` object may be
 * injected for deterministic tests. The helper never starts a process,
 * invokes a package, writes, downloads, indexes, or reads credentials.
 */
export function discoverOptionalIntegrations(setting, environment = {}) {
  const normalized = normalizeSetting(setting);
  const roots = normalizeEnvironment(environment);
  const fileSystem = getFileSystem(environment);
  const integrations = {};

  for (const [name, target] of Object.entries(TARGETS)) {
    if (!normalized.enabled) {
      integrations[name] = result("disabled", { reason: "autodiscovery_disabled" });
      continue;
    }
    if (!normalized.targets[name]) {
      integrations[name] = result("disabled", { reason: "integration_disabled" });
      continue;
    }

    integrations[name] = name === "ponytail"
      ? inspectPonytail(target, roots, fileSystem)
      : inspectFiles(target, roots, fileSystem);
  }

  return Object.freeze({
    enabled: normalized.enabled,
    policy: DISCOVERY_POLICY,
    integrations: Object.freeze(integrations),
  });
}

export const discoverOptionalBackends = discoverOptionalIntegrations;

export function resolveOptionalRoots(environment = {}, { platform = undefined, home = undefined } = {}) {
  const input = readEnvironment(environment);
  const targetPlatform = platform || input.platform || process.platform;
  const pathApi = targetPlatform === "win32" ? path.win32 : path.posix;
  const homeRoot = absolutePath(home || input.home || readEnv(input.env, ["HOME", "USERPROFILE"]) || os.homedir(), pathApi)
    || pathApi.normalize(os.homedir());
  const explicitBase = configuredPath(input, ENV_ROOT_KEYS.basePath, ["CODEX_HOME"], pathApi);
  const explicitLocal = configuredPath(input, ["localAppData", "local_app_data"], ["LOCALAPPDATA"], pathApi, targetPlatform === "win32");
  const explicitApp = configuredPath(input, ["appData", "app_data"], ["APPDATA"], pathApi, targetPlatform === "win32");
  const explicitData = configuredPath(input, ["dataHome", "data_home"], [], pathApi);
  const explicitConfig = configuredPath(input, ["configHome", "config_home"], [], pathApi);
  const xdgData = configuredPath(input, [], ["XDG_DATA_HOME"], pathApi, targetPlatform !== "win32" && targetPlatform !== "darwin");
  const xdgConfig = configuredPath(input, [], ["XDG_CONFIG_HOME"], pathApi, targetPlatform !== "win32" && targetPlatform !== "darwin");

  let localAppData;
  let appData;
  if (targetPlatform === "win32") {
    localAppData = explicitLocal || absolutePath(readEnv(input.env, ["LOCALAPPDATA"]), pathApi) || pathApi.join(homeRoot, "AppData", "Local");
    appData = explicitApp || absolutePath(readEnv(input.env, ["APPDATA"]), pathApi) || pathApi.join(homeRoot, "AppData", "Roaming");
  } else if (targetPlatform === "darwin") {
    localAppData = explicitLocal || explicitData || pathApi.join(homeRoot, "Library", "Application Support");
    appData = explicitApp || explicitConfig || pathApi.join(homeRoot, "Library", "Preferences");
  } else {
    localAppData = explicitLocal || explicitData || xdgData || pathApi.join(homeRoot, ".local", "share");
    appData = explicitApp || explicitConfig || xdgConfig || pathApi.join(homeRoot, ".config");
  }

  const npmPrefix = absolutePath(configuredPath(input, ["npmPrefix", "npm_prefix"], ["NPM_CONFIG_PREFIX", "npm_config_prefix"], pathApi), pathApi);
  const npmGlobalModules = npmPrefix
    ? targetPlatform === "win32"
      ? pathApi.join(npmPrefix, "node_modules")
      : pathApi.join(npmPrefix, "lib", "node_modules")
    : null;

  return Object.freeze({
    platform: targetPlatform,
    home: homeRoot,
    basePath: explicitBase || pathApi.join(homeRoot, ".codex"),
    localAppData,
    appData,
    dataHome: localAppData,
    configHome: appData,
    npmPrefix,
    npmGlobalModules,
  });
}

function normalizeSetting(setting) {
  if (setting === true) return { enabled: true, targets: allTargets(true) };
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
    return { enabled: false, targets: allTargets(false) };
  }

  const enabled = setting.enabled === true || setting.autodiscovery === true;
  const containers = [setting.integrations, setting.backends, setting];
  const targets = {};
  for (const [name, aliases] of Object.entries(TARGET_ALIASES)) {
    const selected = firstSettingValue(containers, aliases);
    targets[name] = selected === undefined ? enabled : selected === true || selected?.enabled === true;
  }
  return { enabled, targets };
}

function allTargets(value) {
  return Object.fromEntries(Object.keys(TARGETS).map((name) => [name, value]));
}

function firstSettingValue(containers, aliases) {
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(container, alias)) return container[alias];
    }
  }
  return undefined;
}

function normalizeEnvironment(environment) {
  return resolveOptionalRoots(environment);
}

function readEnvironment(environment) {
  if (typeof environment === "string") return { basePath: environment, localAppData: environment, appData: environment };
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return { env: {} };
  const nested = environment.env && typeof environment.env === "object" && !Array.isArray(environment.env) ? environment.env : {};
  const env = Object.keys(nested).length ? { ...environment, ...nested } : environment;
  return {
    ...environment,
    env,
  };
}

function firstDefined(environment, keys) {
  for (const key of keys) {
    if (environment[key] !== undefined) return environment[key];
  }
  return undefined;
}

function readEnv(environment, keys) {
  for (const key of keys) {
    const actual = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual !== undefined && environment[actual] !== undefined) return environment[actual];
  }
  return undefined;
}

function absolutePath(value, pathApi) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && pathApi.isAbsolute(value)
    ? pathApi.normalize(value)
    : null;
}

function configuredPath(input, directKeys, envKeys, pathApi, readEnvironment = true) {
  const direct = firstDefined(input, directKeys);
  if (direct !== undefined) return absolutePath(direct, pathApi) || direct;
  if (!readEnvironment) return null;
  const fromEnv = readEnv(input.env, envKeys);
  return fromEnv === undefined ? null : absolutePath(fromEnv, pathApi) || fromEnv;
}

function getFileSystem(environment) {
  const injected = environment && typeof environment === "object" && !Array.isArray(environment) && environment.fs;
  return {
    lstatSync: injected?.lstatSync || fs.lstatSync,
    realpathSync: injected?.realpathSync || fs.realpathSync,
    readdirSync: injected?.readdirSync || fs.readdirSync,
  };
}

function inspectPonytail(target, roots, fileSystem) {
  const rootResult = inspectPath(target, roots, target.relative, fileSystem, { markers: [] });
  if (rootResult.status !== "validated") return rootResult;

  let entries;
  try {
    entries = fileSystem.readdirSync(rootResult.path, { withFileTypes: true });
  } catch (error) {
    return result(error?.code === "ENOENT" ? "absent" : "unavailable", {
      path: rootResult.path,
      reason: error?.code === "ENOENT" ? "path_disappeared" : "directory_unreadable",
      kind: "directory",
    });
  }

  const versions = entries
    .filter((entry) => entry && typeof entry.name === "string" && isVersionName(entry.name) && entry.isDirectory?.() && !entry.isSymbolicLink?.())
    .map((entry) => entry.name)
    .sort(compareVersions);

  if (!versions.length) {
    return result("found", {
      path: rootResult.path,
      reason: "version_directory_missing",
      kind: "directory",
    });
  }

  let found = null;
  let unavailable = null;
  for (const version of versions) {
    const pathApi = roots.platform === "win32" ? path.win32 : path.posix;
    const candidate = pathApi.join(target.relative, version);
    const inspected = inspectPath(target, roots, candidate, fileSystem, { markers: target.markers });
    if (inspected.status === "validated") return Object.freeze({ ...inspected, version });
    if (inspected.status === "found" && !found) found = { ...inspected, version };
    if (inspected.status === "unavailable" && !unavailable) unavailable = inspected;
  }
  return found || unavailable || result("absent", { path: rootResult.path, reason: "version_directory_absent", kind: "directory" });
}

function inspectFiles(target, roots, fileSystem) {
  let found = null;
  let unavailable = null;
  const candidates = target.candidates || [{ root: target.root, relatives: target.relatives }];
  const pathApi = roots.platform === "win32" ? path.win32 : path.posix;
  const hasUsableRoot = candidates.some((candidate) => isAbsoluteSafePath(roots[candidate.root], pathApi));
  for (const candidate of candidates) {
    for (const relative of candidate.relatives) {
      const inspected = inspectPath({ ...target, root: candidate.root }, roots, relative, fileSystem);
      if (inspected.status === "validated") return inspected;
      if (inspected.status === "found" && !found) found = inspected;
      if (inspected.status === "unavailable" && !unavailable) unavailable = inspected;
    }
  }
  return found || (hasUsableRoot ? result("absent", { reason: "known_path_absent", kind: target.expected }) : unavailable)
    || result("absent", { reason: "known_path_absent", kind: target.expected });
}

function inspectPath(target, roots, relative, fileSystem, { markers = target.markers || [] } = {}) {
  const root = roots[target.root];
  const pathApi = roots.platform === "win32" ? path.win32 : path.posix;
  if (!isAbsoluteSafePath(root, pathApi)) return result("unavailable", { reason: "invalid_root" });

  const normalizedRoot = pathApi.normalize(root);
  const candidate = pathApi.resolve(normalizedRoot, relative);
  if (!isWithin(normalizedRoot, candidate, pathApi)) return result("unavailable", { reason: "candidate_outside_root" });

  let rootStat;
  try {
    rootStat = fileSystem.lstatSync(normalizedRoot);
  } catch (error) {
    return result(error?.code === "ENOENT" ? "absent" : "unavailable", {
      path: candidate,
      reason: error?.code === "ENOENT" ? "root_absent" : "root_unavailable",
      kind: target.expected,
    });
  }
  if (rootStat.isSymbolicLink?.() || !rootStat.isDirectory?.()) {
    return result("unavailable", { path: candidate, reason: rootStat.isSymbolicLink?.() ? "root_reparse_point" : "root_not_directory", kind: target.expected });
  }

  let rootReal;
  try {
    rootReal = fileSystem.realpathSync(normalizedRoot);
  } catch {
    return result("unavailable", { path: candidate, reason: "root_unavailable", kind: target.expected });
  }

  let candidateStat;
  try {
    candidateStat = fileSystem.lstatSync(candidate);
  } catch (error) {
    return result(error?.code === "ENOENT" ? "absent" : "unavailable", {
      path: candidate,
      reason: error?.code === "ENOENT" ? "known_path_absent" : "path_unavailable",
      kind: target.expected,
    });
  }
  if (candidateStat.isSymbolicLink?.()) return result("unavailable", { path: candidate, reason: "reparse_point", kind: target.expected });
  if ((target.expected === "directory" && !candidateStat.isDirectory?.()) || (target.expected === "file" && !candidateStat.isFile?.())) {
    return result("unavailable", { path: candidate, reason: "wrong_type", kind: target.expected });
  }

  let candidateReal;
  try {
    candidateReal = fileSystem.realpathSync(candidate);
  } catch {
    return result("unavailable", { path: candidate, reason: "path_unavailable", kind: target.expected });
  }
  if (!isWithin(rootReal, candidateReal, pathApi)) return result("unavailable", { path: candidate, reason: "outside_root", kind: target.expected });

  if (!markers.length) return result("validated", { path: candidate, kind: target.expected });
  for (const marker of markers) {
    const markerPath = pathApi.resolve(candidate, marker);
    if (!isWithin(candidate, markerPath, pathApi)) return result("unavailable", { path: candidate, reason: "marker_outside_root", kind: target.expected });
    let markerStat;
    try {
      markerStat = fileSystem.lstatSync(markerPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return result("unavailable", { path: candidate, reason: "marker_unavailable", kind: target.expected });
    }
    if (markerStat.isSymbolicLink?.()) return result("unavailable", { path: candidate, reason: "marker_reparse_point", kind: target.expected });
    if (!markerStat.isFile?.()) continue;
    let markerReal;
    try {
      markerReal = fileSystem.realpathSync(markerPath);
    } catch {
      return result("unavailable", { path: candidate, reason: "marker_unavailable", kind: target.expected });
    }
    if (!isWithin(rootReal, markerReal, pathApi)) return result("unavailable", { path: candidate, reason: "marker_outside_root", kind: target.expected });
    return result("validated", { path: candidate, marker, kind: target.expected });
  }
  return result("found", { path: candidate, reason: "validation_marker_missing", kind: target.expected });
}

function result(status, details = {}) {
  if (!DISCOVERY_STATES.has(status)) throw new Error(`Unknown discovery state: ${status}`);
  return Object.freeze({
    status,
    found: status === "found" || status === "validated",
    validated: status === "validated",
    path: details.path || null,
    kind: details.kind || null,
    reason: details.reason || null,
    ...(details.marker ? { marker: details.marker } : {}),
    ...(details.version ? { version: details.version } : {}),
  });
}

function isAbsoluteSafePath(value, pathApi = path) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && pathApi.isAbsolute(value);
}

function isWithin(root, candidate, pathApi = path) {
  const relative = pathApi.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function isVersionName(value) {
  return /^\d+\.\d+\.\d+$/u.test(value);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}
