#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCodexRepositories } from "../src/codex-config.mjs";
import { runTui } from "../src/tui.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] || "help";

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
  codescope ui [--config <path>]
  codescope codex-repositories [--text]
  codescope --version

The bridge uses stdio in local-only mode. Repository roots and optional
integrations stay in the local configuration; no tunnel is used.`);
}

function configPath() {
  return resolve(valueFor("--config", process.env.CODESCOPE_CONFIG || join(process.cwd(), "config.json")));
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

async function ui() {
  await runTui({ configPath: configPath(), packageRoot });
}

if (command === "--help" || command === "-h" || command === "help") {
  usage();
} else if (command === "--version" || command === "-v") {
  console.log("0.1.0");
} else if (command === "init") {
  await init();
} else if (command === "serve") {
  await serve();
} else if (command === "doctor") {
  await doctor();
} else if (command === "ui") {
  await ui();
} else if (command === "codex-repositories") {
  await codexRepositories();
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 2;
}
