import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { codescopeLaunchSpec, registerCodeScopeInCodex } from "../src/codex-registration.mjs";

test("Codex registration uses the installed Node entrypoint and serve command", () => {
  const spec = codescopeLaunchSpec({ packageRoot: "C:/CodeScope", nodePath: "node" });
  assert.equal(spec.command, "node");
  assert.deepEqual(spec.args, [join("C:/CodeScope", "bin", "codescope.mjs"), "serve"]);
});

test("Codex registration can pin an explicit bridge configuration", () => {
  const spec = codescopeLaunchSpec({ packageRoot: "C:/CodeScope", nodePath: "node", configPath: "C:/CodeScope/config.json" });
  assert.deepEqual(spec.args, [join("C:/CodeScope", "bin", "codescope.mjs"), "serve", "--config", "C:/CodeScope/config.json"]);
});

test("Codex registration preserves an existing CodeScope entry", () => {
  const calls = [];
  const result = registerCodeScopeInCodex({
    packageRoot: "C:/CodeScope",
    nodePath: "node.exe",
    runner(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.equal(result.status, "already_registered");
  assert.deepEqual(calls, [["codex", ["mcp", "get", "codescope"]]]);
});

test("Codex registration adds a missing entry without npx", () => {
  const calls = [];
  const result = registerCodeScopeInCodex({
    packageRoot: "C:/Code Scope",
    nodePath: "/usr/bin/node",
    runner(command, args) {
      calls.push([command, args]);
      return { status: calls.length === 1 ? 1 : 0 };
    },
  });
  assert.equal(result.status, "registered");
  assert.deepEqual(calls, [
    ["codex", ["mcp", "get", "codescope"]],
    ["codex", ["mcp", "add", "codescope", "--", "/usr/bin/node", join("C:/Code Scope", "bin", "codescope.mjs"), "serve"]],
  ]);
  assert.equal(calls.flat(2).includes("npx"), false);
});

test("Codex registration reports an unavailable CLI without throwing", () => {
  const result = registerCodeScopeInCodex({
    packageRoot: "C:/CodeScope",
    runner() {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(result, { status: "codex_unavailable" });
});

test("Codex registration handles a missing CLI reported by spawnSync", () => {
  const error = new Error("missing");
  error.code = "ENOENT";
  const result = registerCodeScopeInCodex({
    packageRoot: "C:/CodeScope",
    runner() {
      return { status: null, error };
    },
  });
  assert.deepEqual(result, { status: "codex_unavailable" });
});
