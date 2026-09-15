import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROJECT_SECTION = /^\s*\[\s*projects\s*\.\s*(["'])(.*?)\1\s*\]\s*(?:#.*)?$/u;

export function resolveCodexHome(environment = process.env, homeDirectory = os.homedir()) {
  const configured = typeof environment?.CODEX_HOME === "string" ? environment.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.resolve(homeDirectory, ".codex");
}

export function resolveCodexConfigPath(environment = process.env, homeDirectory = os.homedir()) {
  return path.join(resolveCodexHome(environment, homeDirectory), "config.toml");
}

export function parseCodexProjectPaths(contents) {
  const paths = [];
  const seen = new Set();

  for (const line of String(contents).split(/\r?\n/u)) {
    const match = PROJECT_SECTION.exec(line);
    if (!match) continue;

    const projectPath = match[1] === '"' ? decodeBasicString(match[2]) : match[2];
    if (!projectPath || !isAbsolutePath(projectPath)) continue;

    const normalized = normalizePath(projectPath);
    const key = path.win32.isAbsolute(projectPath) && !path.posix.isAbsolute(projectPath)
      ? normalized.toLowerCase()
      : process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(normalized);
  }

  return paths;
}

export async function discoverCodexRepositories({ environment = process.env, homeDirectory = os.homedir() } = {}) {
  const codexHome = resolveCodexHome(environment, homeDirectory);
  const configPath = path.join(codexHome, "config.toml");

  let contents;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { codex_home: codexHome, config_path: configPath, config_exists: false, candidates: [] };
    }
    throw error;
  }

  return {
    codex_home: codexHome,
    config_path: configPath,
    config_exists: true,
    candidates: parseCodexProjectPaths(contents).map((repositoryPath) => ({
      path: repositoryPath,
      authorized: false,
    })),
  };
}

function decodeBasicString(value) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escaped = value[++index];
    const simple = { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" }[escaped];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }

    const length = escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
    const code = length ? value.slice(index + 1, index + 1 + length) : "";
    if (!length || !/^[0-9a-f]+$/iu.test(code)) return null;
    decoded += String.fromCodePoint(Number.parseInt(code, 16));
    index += length;
  }
  return decoded;
}

function isAbsolutePath(value) {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizePath(value) {
  const windowsPath = path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
  return (windowsPath ? path.win32 : path).normalize(value);
}
