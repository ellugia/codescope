#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCodexRepositories } from "../src/codex-config.mjs";
import { resolveConfigPath } from "../src/config-paths.mjs";
import { registerCodeScopeInCodex } from "../src/codex-registration.mjs";
import { runTui, writeUiConfig } from "../src/tui.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] || "help";

function localCliCommand(subcommand) {
  return `${process.execPath} "${join(packageRoot, "bin", "codescope.mjs")}" ${subcommand}`;
}

function valueFor(flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function usage() {
  console.log(`CodeScope local read-only MCP bridge

Usage:
  codescope init [--config <path>] [--force]
  codescope serve [--config <path>]
  codescope doctor [--config <path>]
  codescope setup [--config <path>]
  codescope ui [--config <path>]
  codescope codex-repositories [--text]
  codescope instructions
  codescope --version

The bridge uses stdio in local-only mode. Repository roots and optional
integrations stay in the local configuration; no tunnel is used.`);
}

function configPath() {
  return resolveConfigPath({ explicitPath: valueFor("--config") });
}

async function init() {
  const target = configPath();
  const source = join(packageRoot, "config.example.json");
  if (!args.includes("--force")) {
    try {
      await import("node:fs/promises").then(({ access }) => access(target));
      throw new Error(`Configuration already exists: ${target}. Use --force to replace it.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(`Created local configuration template: ${target}`);
  console.log(`Next recommended step: ${localCliCommand("instructions")}`);
}

async function serve() {
  process.env.CODESCOPE_CONFIG = configPath();
  await import(pathToFileURL(join(packageRoot, "src", "server.mjs")));
}

async function doctor() {
  process.env.CODESCOPE_CONFIG = configPath();
  await import(pathToFileURL(join(packageRoot, "scripts", "doctor.mjs")));
}

async function codexRepositories() {
  const result = await discoverCodexRepositories();
  if (args.includes("--text")) {
    for (const candidate of result.candidates) console.log(candidate.path);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function instructions() {
  const source = join(packageRoot, "chatgpt", "project-instructions.md");
  process.stdout.write(await readFile(source, "utf8"));
}

async function ui() {
  await runTui({ configPath: configPath(), packageRoot });
}

async function setup() {
  const target = configPath();
  let created = false;
  try {
    await import("node:fs/promises").then(({ access }) => access(target));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeUiConfig(target, { repositories: {}, optional_backends: { auto_discover: false, bindings: {} } });
    created = true;
  }

  console.log(`${created ? "Created" : "Using"} local configuration: ${target}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Run \`${localCliCommand("setup")}\` from an interactive terminal to configure repositories.`);
    return;
  }
  await runTui({ configPath: target, packageRoot });
  const register = await askYesNo("Register CodeScope in Codex now?");
  if (register) {
    const result = registerCodeScopeInCodex({ packageRoot, configPath: target });
    const messages = {
      registered: "CodeScope was registered in Codex.",
      already_registered: "CodeScope is already registered in Codex; the existing entry was preserved.",
      codex_unavailable: "Codex was not found. The local configuration is ready; register the MCP from Codex when it is installed.",
      codex_check_failed: "Codex could not be checked. The local configuration is ready; no existing entry was changed.",
      registration_failed: "CodeScope could not be registered in Codex. The local configuration is ready; no existing entry was changed.",
    };
    console.log(messages[result.status] || messages.registration_failed);
  }
  console.log(`Setup finished. Use \`${localCliCommand("instructions")}\` when you need the ChatGPT Project instructions.`);
}

async function askYesNo(question) {
  const { createInterface } = await import("node:readline/promises");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    input.close();
  }
}

if (command === "--help" || command === "-h" || command === "help") {
  usage();
} else if (command === "--version" || command === "-v") {
  console.log("0.1.1");
} else if (command === "init") {
  await init();
} else if (command === "serve") {
  await serve();
} else if (command === "doctor") {
  await doctor();
} else if (command === "setup") {
  await setup();
} else if (command === "ui") {
  await ui();
} else if (command === "codex-repositories") {
  await codexRepositories();
} else if (command === "instructions") {
  await instructions();
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 2;
}
