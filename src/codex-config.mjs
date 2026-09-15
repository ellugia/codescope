import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

export const CODEX_CONFIG_LIMITS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxLines: 100_000,
  maxLineChars: 16_384,
  maxCandidates: 512,
  maxPathChars: 4_096,
  maxErrors: 16,
});

const CONTROL_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export function resolveCodexHome(environment = process.env, homeDirectory = os.homedir()) {
  const configured = typeof environment?.CODEX_HOME === "string" ? environment.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.resolve(homeDirectory, ".codex");
}

export function resolveCodexConfigPath(environment = process.env, homeDirectory = os.homedir()) {
  return path.join(resolveCodexHome(environment, homeDirectory), "config.toml");
}

export function parseCodexProjectPaths(contents) {
  return parseCodexProjectPathsDetailed(contents).paths;
}

export async function discoverCodexRepositories({ environment = process.env, homeDirectory = os.homedir() } = {}) {
  const codexHome = resolveCodexHome(environment, homeDirectory);
  const configPath = path.join(codexHome, "config.toml");
  const base = { codex_home: codexHome, config_path: configPath, config_exists: true, candidates: [] };

  let contents;
  try {
    const result = await readBoundedConfig(configPath);
    if (result.error) return { ...base, error: { code: result.error } };
    contents = result.contents;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { codex_home: codexHome, config_path: configPath, config_exists: false, candidates: [] };
    }
    return { ...base, error: { code: "config_unavailable" } };
  }

  const parsed = parseCodexProjectPathsDetailed(contents);
  const result = {
    ...base,
    candidates: parsed.paths.map((repositoryPath) => ({
      path: repositoryPath,
      authorized: false,
    })),
  };
  if (parsed.errors.length) result.error = { code: "config_malformed", lines: parsed.errors };
  return result;
}

function isAbsolutePath(value) {
  return typeof value === "string"
    && (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

function normalizePath(value) {
  const windowsPath = path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
  return (windowsPath ? path.win32 : path).normalize(value);
}

async function readBoundedConfig(configPath) {
  let handle;
  try {
    handle = await open(configPath, "r");
    const before = await handle.stat();
    if (!before.isFile()) return { error: "config_not_file" };
    if (before.size > CODEX_CONFIG_LIMITS.maxBytes) return { error: "config_too_large" };

    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size > CODEX_CONFIG_LIMITS.maxBytes || after.size !== before.size || offset < before.size) {
      return { error: "config_changed" };
    }
    try {
      return { contents: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)) };
    } catch {
      return { error: "config_invalid_utf8" };
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseCodexProjectPathsDetailed(contents) {
  const paths = [];
  const seen = new Set();
  const errors = [];
  if (typeof contents !== "string") return { paths, errors: [{ line: 0, code: "config_not_text" }] };

  const lines = contents.split("\n");
  const addError = (line, code) => {
    if (errors.length < CODEX_CONFIG_LIMITS.maxErrors) errors.push({ line, code });
  };
  if (lines.length > CODEX_CONFIG_LIMITS.maxLines) addError(CODEX_CONFIG_LIMITS.maxLines + 1, "too_many_lines");

  for (let lineNumber = 1; lineNumber <= Math.min(lines.length, CODEX_CONFIG_LIMITS.maxLines); lineNumber += 1) {
    const line = lines[lineNumber - 1].endsWith("\r") ? lines[lineNumber - 1].slice(0, -1) : lines[lineNumber - 1];
    if (!/^\s*\[\s*projects(?:\s*\.|\s*\])/u.test(line)) continue;
    if (line.length > CODEX_CONFIG_LIMITS.maxLineChars) {
      addError(lineNumber, "line_too_long");
      continue;
    }
    const parsed = parseProjectSection(line);
    if (parsed.error) {
      addError(lineNumber, parsed.error);
      continue;
    }
    if (parsed.path === null) continue;
    const candidate = safeProjectPath(parsed.path);
    if (candidate.error) {
      addError(lineNumber, candidate.error);
      continue;
    }
    const normalized = normalizePath(candidate.path);
    const key = path.win32.isAbsolute(normalized) && !path.posix.isAbsolute(normalized)
      ? normalized.toLowerCase()
      : process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    if (paths.length >= CODEX_CONFIG_LIMITS.maxCandidates) {
      addError(lineNumber, "too_many_candidates");
      break;
    }
    seen.add(key);
    paths.push(normalized);
  }

  return { paths, errors };
}

function parseProjectSection(line) {
  let index = 0;
  index = skipWhitespace(line, index);
  if (line[index++] !== "[") return { error: "invalid_project_section" };
  index = skipWhitespace(line, index);
  if (line.slice(index, index + 8) !== "projects") return { error: "invalid_project_section" };
  index += 8;
  if (line[index] !== "." && line[index] !== "]" && !/\s/u.test(line[index] || "")) return { error: "invalid_project_section" };
  index = skipWhitespace(line, index);
  if (line[index] === "]") return { path: null };
  if (line[index++] !== ".") return { error: "invalid_project_section" };
  index = skipWhitespace(line, index);
  const quote = line[index];
  if (quote !== '"' && quote !== "'") return { error: "invalid_project_section" };
  const value = parseTomlString(line, index + 1, quote);
  if (value.error) return value;
  index = skipWhitespace(line, value.next);
  if (line[index++] !== "]") return { error: "invalid_project_section" };
  index = skipWhitespace(line, index);
  if (index < line.length && line[index] !== "#") return { error: "invalid_project_section" };
  return { path: value.value };
}

function parseTomlString(line, start, quote) {
  let value = "";
  for (let index = start; index < line.length;) {
    const codePoint = line.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (character === quote) return { value, next: index };
    if (quote === '"' && character === "\\") {
      if (index >= line.length) return { error: "invalid_string_escape" };
      const escaped = line[index++];
      const simple = { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" }[escaped];
      if (simple !== undefined) {
        value += simple;
        continue;
      }
      const length = escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
      const digits = length ? line.slice(index, index + length) : "";
      if (!length || digits.length !== length || !/^[0-9a-f]+$/iu.test(digits)) return { error: "invalid_string_escape" };
      const code = Number.parseInt(digits, 16);
      if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return { error: "invalid_unicode" };
      value += String.fromCodePoint(code);
      index += length;
      continue;
    }
    if (CONTROL_RE.test(character)) return { error: "unsafe_string" };
    value += character;
  }
  return { error: "unterminated_string" };
}

function safeProjectPath(value) {
  if (typeof value !== "string" || !value) return { error: "empty_project_path" };
  const normalizedUnicode = value.normalize("NFC");
  if (normalizedUnicode.length > CODEX_CONFIG_LIMITS.maxPathChars) return { error: "project_path_too_long" };
  if (CONTROL_RE.test(normalizedUnicode)) return { error: "unsafe_project_path" };
  if (!isAbsolutePath(normalizedUnicode)) return { error: "project_path_not_absolute" };
  return { path: normalizedUnicode };
}

function skipWhitespace(line, index) {
  while (index < line.length && /\s/u.test(line[index])) index += 1;
  return index;
}
