import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function absoluteOrNull(value, paths) {
  return nonEmpty(value) && paths.isAbsolute(value) ? value : null;
}

export function userConfigDirectory({ platform = process.platform, env = process.env, homeDirectory = os.homedir() } = {}) {
  const paths = pathApi(platform);
  if (platform === "win32") {
    return paths.join(absoluteOrNull(env.APPDATA, paths) || paths.join(homeDirectory, "AppData", "Roaming"), "CodeScope");
  }
  if (platform === "darwin") return paths.join(homeDirectory, "Library", "Application Support", "CodeScope");
  return paths.join(absoluteOrNull(env.XDG_CONFIG_HOME, paths) || paths.join(homeDirectory, ".config"), "codescope");
}

export function userConfigPath(options = {}) {
  const platform = options.platform || process.platform;
  return pathApi(platform).join(userConfigDirectory(options), "config.json");
}

export function resolveConfigPath({
  explicitPath = null,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  homeDirectory = os.homedir(),
  exists = existsSync,
} = {}) {
  const paths = pathApi(platform);
  if (nonEmpty(explicitPath)) return paths.resolve(cwd, explicitPath);
  if (nonEmpty(env.CODESCOPE_CONFIG)) return paths.resolve(cwd, env.CODESCOPE_CONFIG);

  const userPath = userConfigPath({ platform, env, homeDirectory });
  if (exists(userPath)) return userPath;

  const legacyPath = paths.resolve(cwd, "config.json");
  if (exists(legacyPath)) return legacyPath;
  return userPath;
}
