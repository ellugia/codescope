import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fixtureRoot = process.env.BRIDGE_FIXTURE_ROOT;
if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) {
  throw new Error("BRIDGE_FIXTURE_ROOT must be an absolute fixture path.");
}

const configPath = path.join(path.dirname(fixtureRoot), "bridge-config.json");
await mkdir(path.dirname(configPath), { recursive: true });
await writeFile(configPath, JSON.stringify({
  repositories: {
    "fixture-root": { root: fixtureRoot, read_only: true },
    "fixture-repo": { root: fixtureRoot, read_only: true },
  },
  default_repository: "fixture-root",
  limits: {
    max_response_bytes: 65_536,
    max_file_bytes: 512 * 1024,
    max_entries: 200,
    max_matches: 100,
    max_lines: 2_000,
    max_depth: 6,
    max_git_output_bytes: 128 * 1024,
    timeout_ms: 5_000,
  },
  optional_backends: { auto_discover: false, bindings: {} },
}), "utf8");

process.env.CODESCOPE_CONFIG = configPath;
const serverPath = process.env.BRIDGE_SERVER_PATH
  ? path.resolve(process.env.BRIDGE_SERVER_PATH)
  : path.resolve(import.meta.dirname, "..", "src", "server.mjs");
await import(pathToFileURL(serverPath));
