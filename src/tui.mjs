import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { discoverCodexRepositories } from "./codex-config.mjs";

const ALIAS_RE = /^[a-z][a-z0-9_-]{0,31}$/u;

export function decodeKey(sequence) {
  if (sequence === "\u0003") return "ctrl-c";
  if (sequence === "\u0004") return "ctrl-d";
  if (sequence === "\u001b[A" || sequence === "k") return "up";
  if (sequence === "\u001b[B" || sequence === "j") return "down";
  if (sequence === "\r" || sequence === "\n" || sequence === " ") return "select";
  if (sequence === "q" || sequence === "Q" || sequence === "\u001b") return "back";
  return null;
}

export async function readUiConfig(configPath) {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Configuration not found: ${configPath}. Run codescope init first.`);
    throw new Error(`Configuration is not valid JSON: ${configPath}`);
  }
}

export async function writeUiConfig(configPath, config) {
  const parent = path.dirname(configPath);
  await mkdir(parent, { recursive: true });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, configPath);
}

function repositoriesOf(config) {
  if (!config.repositories || typeof config.repositories !== "object" || Array.isArray(config.repositories)) config.repositories = {};
  return config.repositories;
}

function optionalOf(config) {
  if (!config.optional_backends || typeof config.optional_backends !== "object" || Array.isArray(config.optional_backends)) {
    config.optional_backends = { auto_discover: false, bindings: {} };
  }
  if (!config.optional_backends.bindings || typeof config.optional_backends.bindings !== "object" || Array.isArray(config.optional_backends.bindings)) {
    config.optional_backends.bindings = {};
  }
  return config.optional_backends;
}

function active(entry) {
  return entry?.enabled !== false;
}

export function activeAliases(config) {
  return Object.entries(repositoriesOf(config)).filter(([, entry]) => active(entry)).map(([alias]) => alias);
}

export function aliasForPath(root, repositories = {}) {
  const base = path.basename(path.normalize(root)).toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^[^a-z]+/u, "").slice(0, 32) || "repo";
  let alias = base;
  let suffix = 2;
  while (repositories[alias]) {
    const tail = `-${suffix++}`;
    alias = `${base.slice(0, 32 - tail.length)}${tail}`;
  }
  return alias;
}

export async function addRepository(config, root, alias = null) {
  const absolute = path.resolve(root);
  if (!path.isAbsolute(absolute)) throw new Error("The repository folder must be an absolute path.");
  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`The folder does not exist or is not a directory: ${absolute}`);
  const repositories = repositoriesOf(config);
  const selectedAlias = alias || aliasForPath(absolute, repositories);
  if (!ALIAS_RE.test(selectedAlias)) throw new Error("The alias must start with a letter and use only letters, numbers, hyphens, or underscores.");
  if (repositories[selectedAlias]) throw new Error(`The alias already exists: ${selectedAlias}`);
  repositories[selectedAlias] = { root: absolute, read_only: true };
  if (!config.default_repository || !activeAliases(config).length) config.default_repository = selectedAlias;
  return selectedAlias;
}

export function setRepositoryEnabled(config, alias, enabled) {
  const repositories = repositoriesOf(config);
  if (!repositories[alias]) throw new Error(`Unknown repository: ${alias}`);
  if (!enabled && activeAliases(config).length <= 1) throw new Error("At least one repository must remain active.");
  repositories[alias].enabled = Boolean(enabled);
  if (enabled && !config.default_repository) config.default_repository = alias;
  if (!enabled && config.default_repository === alias) config.default_repository = activeAliases(config)[0] || null;
}

export function removeRepository(config, alias) {
  const repositories = repositoriesOf(config);
  if (!repositories[alias]) throw new Error(`Unknown repository: ${alias}`);
  if (active(repositories[alias]) && activeAliases(config).length <= 1) throw new Error("At least one repository must remain active.");
  delete repositories[alias];
  const optional = optionalOf(config);
  delete optional.bindings[alias];
  if (config.default_repository === alias) config.default_repository = activeAliases(config)[0] || Object.keys(repositories)[0] || null;
}

export function setDefaultRepository(config, alias) {
  if (!repositoriesOf(config)[alias] || !active(repositoriesOf(config)[alias])) throw new Error("The repository must exist and be active.");
  config.default_repository = alias;
}

export function setAutoDiscovery(config, enabled) {
  optionalOf(config).auto_discover = Boolean(enabled);
}

export function setOptionalBackendEnabled(config, alias, backend, enabled) {
  const optional = optionalOf(config);
  const binding = optional.bindings[alias];
  if (!binding || !binding[backend]) throw new Error(`No binding is configured for ${backend} in ${alias}.`);
  binding[backend].enabled = Boolean(enabled);
}

const MENU_FOOTER = "↑/↓ or j/k Move · Enter Select · Esc/q Back · Ctrl+C Quit";
const ROOT_FOOTER = "↑/↓ or j/k Move · Enter Select · Esc/q Exit · Ctrl+C Quit";

export function renderMenu(title, lines, selected = -1, status = "", footer = MENU_FOOTER) {
  const rows = lines.map((line, index) => index === selected
    ? `\u001b[36m❯\u001b[0m \u001b[1m${line}\u001b[0m`
    : `  ${line}`);
  return [
    "\u001b[2J\u001b[H\u001b[1;36mCodeScope\u001b[0m",
    `\u001b[1m${title}\u001b[0m`,
    "\u001b[90mLocal read-only bridge configuration\u001b[0m",
    `\u001b[33mStatus · ${status || "Ready"}\u001b[0m`,
    "",
    ...rows,
    "",
    `\u001b[90m${footer}\u001b[0m`,
  ].join("\n");
}

function draw(title, lines, selected = -1, status = "", footer = MENU_FOOTER) {
  process.stdout.write(`${renderMenu(title, lines, selected, status, footer)}\n`);
}

function createRawMenu(title, entries, status, footer = MENU_FOOTER) {
  return new Promise((resolve) => {
    let selected = 0;
    const onKeypress = (str, key = {}) => {
      const action = key.name === "up" ? "up" : key.name === "down" ? "down" : decodeKey(str);
      if (action === "up" && entries.length) selected = (selected + entries.length - 1) % entries.length;
      else if (action === "down" && entries.length) selected = (selected + 1) % entries.length;
      else if (action === "back" || action === "ctrl-c" || action === "ctrl-d") finish(null);
      else if (action === "select" && entries.length) finish(entries[selected]);
      if ((action === "up" || action === "down") && entries.length) draw(title, entries.map((entry) => entry.label), selected, status, footer);
    };
    const finish = (value) => {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(value);
    };
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    draw(title, entries.map((entry) => entry.label), selected, status, footer);
  });
}

async function prompt(question) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.resume();
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => input.question(`${question} `, resolve));
  input.close();
  return answer.trim();
}

async function confirm(question) {
  return /^(?:y|yes)$/iu.test(await prompt(`${question} [y/N]:`));
}

async function runDoctor(configPath) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/doctor.mjs")], {
      env: { ...process.env, CODESCOPE_CONFIG: configPath },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("close", resolve);
    child.once("error", resolve);
  });
}

export async function runTui({ configPath, packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The TUI requires an interactive terminal.");
  const config = await readUiConfig(configPath);
  let notice = "Local configuration loaded.";
  const waitNotice = async () => {
    await prompt("Press Enter to continue:");
  };
  const repositoryMenu = async () => {
    while (true) {
      const repositories = repositoriesOf(config);
      const lines = Object.entries(repositories).map(([alias, entry]) => `${alias} · ${active(entry) ? "ACTIVE" : "DISABLED"} · ${entry.root}`);
      const choice = await createRawMenu("Repositories", [
        { label: "Add folder", value: "add" },
        { label: "Add from Codex", value: "codex" },
        { label: "Enable or disable", value: "toggle" },
        { label: "Remove repository", value: "remove" },
        { label: "Set default repository", value: "default" },
        { label: "Back", value: "back" },
      ], `${lines.length ? lines.join(" · ") : "No repositories configured."}`);
      if (!choice || choice.value === "back") return;
      try {
        if (choice.value === "add") {
          const root = await prompt("Absolute repository folder:");
          const alias = await prompt("Alias (press Enter to suggest one):");
          await addRepository(config, root, alias || null);
          await writeUiConfig(configPath, config);
          notice = "Repository added and saved.";
        } else if (choice.value === "codex") {
          const found = await discoverCodexRepositories();
          if (!found.candidates.length) throw new Error("No candidates found in CODEX_HOME/config.toml.");
          const choices = found.candidates.map((candidate, index) => ({ label: `${index + 1}. ${candidate.path}`, value: candidate }));
          const selected = await createRawMenu("Codex candidates", [...choices, { label: "Back", value: null }], "Candidates do not grant access automatically.");
          if (selected?.value) {
            const alias = await prompt("Alias (press Enter to suggest one):");
            await addRepository(config, selected.value.path, alias || null);
            await writeUiConfig(configPath, config);
            notice = "Candidate added to the local allowlist.";
          }
        } else {
          const aliases = Object.keys(repositories);
          if (!aliases.length) throw new Error("No repositories configured.");
          const selected = await createRawMenu("Select a repository", [...aliases.map((alias) => ({ label: `${alias} · ${active(repositories[alias]) ? "ACTIVE" : "DISABLED"}`, value: alias })), { label: "Back", value: null }], "");
          if (!selected?.value) continue;
          if (choice.value === "toggle") {
            if (active(repositories[selected.value]) && !(await confirm(`Disable repository \"${selected.value}\"?`))) {
              notice = "Disable cancelled.";
              continue;
            }
            setRepositoryEnabled(config, selected.value, !active(repositories[selected.value]));
            await writeUiConfig(configPath, config);
            notice = "Repository status saved.";
          } else if (choice.value === "remove") {
            if (!(await confirm(`Remove repository \"${selected.value}\" from the local configuration?`))) {
              notice = "Removal cancelled.";
              continue;
            }
            removeRepository(config, selected.value);
            await writeUiConfig(configPath, config);
            notice = "Repository removed from the configuration.";
          } else if (choice.value === "default") {
            setDefaultRepository(config, selected.value);
            await writeUiConfig(configPath, config);
            notice = "Default repository saved.";
          }
        }
      } catch (error) {
        notice = `Change not applied: ${error.message}`;
        await waitNotice();
      }
    }
  };
  const optionalMenu = async () => {
    while (true) {
      const optional = optionalOf(config);
      const bindings = Object.entries(optional.bindings).flatMap(([alias, binding]) => [
        binding.codebase_memory ? { label: `Codebase Memory · ${alias} · ${binding.codebase_memory.enabled === false ? "DISABLED" : "ACTIVE"}`, value: [alias, "codebase_memory"] } : null,
        binding.context_mode ? { label: `Context Mode · ${alias} · ${binding.context_mode.enabled === false ? "DISABLED" : "ACTIVE"}`, value: [alias, "context_mode"] } : null,
      ].filter(Boolean));
      const choice = await createRawMenu("Optional integrations", [
        { label: `Automatic discovery: ${optional.auto_discover ? "ACTIVE" : "DISABLED"}`, value: "auto" },
        ...bindings,
        { label: "Back", value: "back" },
      ], "Only explicit read-only bindings are used.");
      if (!choice || choice.value === "back") return;
      try {
        if (choice.value === "auto") {
          if (optional.auto_discover && !(await confirm("Disable automatic discovery?"))) {
            notice = "Disable cancelled.";
            continue;
          }
          setAutoDiscovery(config, !Boolean(optional.auto_discover));
        } else {
          const [alias, backend] = choice.value;
          const enabled = optional.bindings[alias][backend].enabled !== false;
          if (enabled && !(await confirm(`Disable ${backend} for ${alias}?`))) {
            notice = "Disable cancelled.";
            continue;
          }
          setOptionalBackendEnabled(config, alias, backend, !enabled);
        }
        await writeUiConfig(configPath, config);
        notice = "Optional configuration saved.";
      } catch (error) {
        notice = `Change not applied: ${error.message}`;
        await waitNotice();
      }
    }
  };
  while (true) {
    const repositories = repositoriesOf(config);
    const choice = await createRawMenu("Local configuration", [
      { label: `Repositories (${activeAliases(config).length} active / ${Object.keys(repositories).length} configured)`, value: "repos" },
      { label: "Optional integrations", value: "optional" },
      { label: "Run doctor", value: "doctor" },
      { label: "Start local bridge (Ctrl+C to stop)", value: "serve" },
      { label: "Exit", value: "exit" },
    ], notice, ROOT_FOOTER);
    notice = "";
    if (!choice || choice.value === "exit") return;
    if (choice.value === "repos") await repositoryMenu();
    else if (choice.value === "optional") await optionalMenu();
    else if (choice.value === "doctor") {
      await runDoctor(configPath);
      await waitNotice();
    } else if (choice.value === "serve") {
      process.stdout.write("\nThe local bridge will use this terminal. Press Ctrl+C to stop it.\n");
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(packageRoot, "src", "server.mjs")], { env: { ...process.env, CODESCOPE_CONFIG: configPath }, stdio: "inherit", windowsHide: true });
        child.once("close", resolve);
        child.once("error", resolve);
      });
      notice = "The bridge has stopped.";
    }
  }
}
