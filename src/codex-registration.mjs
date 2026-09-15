import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function codescopeLaunchSpec({ packageRoot, nodePath = process.execPath, configPath = null }) {
  const args = [join(packageRoot, "bin", "codescope.mjs"), "serve"];
  if (configPath) args.push("--config", configPath);
  return Object.freeze({
    command: nodePath,
    args: Object.freeze(args),
  });
}

export function registerCodeScopeInCodex({
  packageRoot,
  nodePath = process.execPath,
  configPath = null,
  env = process.env,
  runner = spawnSync,
} = {}) {
  if (!packageRoot) throw new TypeError("packageRoot is required");
  // Node resolves the Windows .cmd shim through PATHEXT when the bare command is used.
  const executable = "codex";
  const options = { cwd: packageRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  let existing;
  try {
    existing = runner(executable, ["mcp", "get", "codescope"], options);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "codex_unavailable" };
    return { status: "codex_check_failed", exitCode: null };
  }
  if (existing?.error?.code === "ENOENT") return { status: "codex_unavailable" };
  if (existing?.error) return { status: "codex_check_failed", exitCode: existing.status ?? null };
  if (existing?.status === 0) return { status: "already_registered" };

  const launch = codescopeLaunchSpec({ packageRoot, nodePath, configPath });
  let added;
  try {
    added = runner(executable, ["mcp", "add", "codescope", "--", launch.command, ...launch.args], options);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "codex_unavailable" };
    return { status: "registration_failed", exitCode: null };
  }
  if (added?.error?.code === "ENOENT") return { status: "codex_unavailable" };
  if (added?.error) return { status: "registration_failed", exitCode: added.status ?? null };
  if (added?.status === 0) return { status: "registered" };
  return { status: "registration_failed", exitCode: added?.status ?? null };
}
