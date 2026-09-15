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
    if (error?.code === "ENOENT") throw new Error(`No existe la configuración: ${configPath}. Ejecuta primero codescope init.`);
    throw new Error(`La configuración no es JSON válido: ${configPath}`);
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
  if (!path.isAbsolute(absolute)) throw new Error("La carpeta debe ser una ruta absoluta.");
  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`La carpeta no existe o no es un directorio: ${absolute}`);
  const repositories = repositoriesOf(config);
  const selectedAlias = alias || aliasForPath(absolute, repositories);
  if (!ALIAS_RE.test(selectedAlias)) throw new Error("El alias debe empezar por una letra y usar solo letras, números, guion o guion bajo.");
  if (repositories[selectedAlias]) throw new Error(`El alias ya existe: ${selectedAlias}`);
  repositories[selectedAlias] = { root: absolute, read_only: true };
  if (!config.default_repository || !activeAliases(config).length) config.default_repository = selectedAlias;
  return selectedAlias;
}

export function setRepositoryEnabled(config, alias, enabled) {
  const repositories = repositoriesOf(config);
  if (!repositories[alias]) throw new Error(`Repositorio desconocido: ${alias}`);
  if (!enabled && activeAliases(config).length <= 1) throw new Error("Debe quedar al menos un repositorio activo.");
  repositories[alias].enabled = Boolean(enabled);
  if (enabled && !config.default_repository) config.default_repository = alias;
}

export function removeRepository(config, alias) {
  const repositories = repositoriesOf(config);
  if (!repositories[alias]) throw new Error(`Repositorio desconocido: ${alias}`);
  if (active(repositories[alias]) && activeAliases(config).length <= 1) throw new Error("Debe quedar al menos un repositorio activo.");
  delete repositories[alias];
  const optional = optionalOf(config);
  delete optional.bindings[alias];
  if (config.default_repository === alias) config.default_repository = activeAliases(config)[0] || Object.keys(repositories)[0] || null;
}

export function setDefaultRepository(config, alias) {
  if (!repositoriesOf(config)[alias] || !active(repositoriesOf(config)[alias])) throw new Error("El repositorio debe existir y estar activo.");
  config.default_repository = alias;
}

export function setAutoDiscovery(config, enabled) {
  optionalOf(config).auto_discover = Boolean(enabled);
}

export function setOptionalBackendEnabled(config, alias, backend, enabled) {
  const optional = optionalOf(config);
  const binding = optional.bindings[alias];
  if (!binding || !binding[backend]) throw new Error(`No hay una binding configurada para ${backend} en ${alias}.`);
  binding[backend].enabled = Boolean(enabled);
}

function draw(title, lines, selected = -1, footer = "↑/↓ mover · Enter elegir · Esc volver") {
  const output = [`\u001b[2J\u001b[H\u001b[1mCodeScope · ${title}\u001b[0m`, "", ...lines.map((line, index) => index === selected ? `\u001b[36m❯ ${line}\u001b[0m` : `  ${line}`), "", `\u001b[90m${footer}\u001b[0m`];
  process.stdout.write(`${output.join("\n")}\n`);
}

function createRawMenu(title, entries, status) {
  return new Promise((resolve) => {
    let selected = 0;
    const onKeypress = (str, key = {}) => {
      const action = key.name === "up" ? "up" : key.name === "down" ? "down" : decodeKey(str);
      if (action === "up") selected = (selected + entries.length - 1) % entries.length;
      else if (action === "down") selected = (selected + 1) % entries.length;
      else if (action === "back" || action === "ctrl-c" || action === "ctrl-d") finish(null);
      else if (action === "select") finish(entries[selected]);
      if (action === "up" || action === "down") draw(title, entries.map((entry) => entry.label), selected, status);
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
    draw(title, entries.map((entry) => entry.label), selected, status);
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
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("La TUI necesita una terminal interactiva.");
  const config = await readUiConfig(configPath);
  let notice = "Configuración local cargada.";
  const waitNotice = async () => {
    await prompt("Pulsa Enter para continuar:");
  };
  const repositoryMenu = async () => {
    while (true) {
      const repositories = repositoriesOf(config);
      const lines = Object.entries(repositories).map(([alias, entry]) => `${alias} · ${active(entry) ? "ACTIVO" : "INACTIVO"} · ${entry.root}`);
      const choice = await createRawMenu("Repositorios", [
        { label: "Añadir carpeta", value: "add" },
        { label: "Añadir desde Codex", value: "codex" },
        { label: "Activar o desactivar", value: "toggle" },
        { label: "Eliminar repositorio", value: "remove" },
        { label: "Elegir repositorio predeterminado", value: "default" },
        { label: "Volver", value: "back" },
      ], `${lines.length ? lines.join(" · ") : "Sin repositorios"}`);
      if (!choice || choice.value === "back") return;
      try {
        if (choice.value === "add") {
          const root = await prompt("Carpeta absoluta del repositorio:");
          const alias = await prompt("Alias (Enter para sugerirlo):");
          await addRepository(config, root, alias || null);
          await writeUiConfig(configPath, config);
          notice = "Repositorio añadido y guardado.";
        } else if (choice.value === "codex") {
          const found = await discoverCodexRepositories();
          if (!found.candidates.length) throw new Error("No hay candidatos en CODEX_HOME/config.toml.");
          const choices = found.candidates.map((candidate, index) => ({ label: `${index + 1}. ${candidate.path}`, value: candidate }));
          const selected = await createRawMenu("Candidatos Codex", [...choices, { label: "Volver", value: null }], "Los candidatos no conceden acceso automáticamente.");
          if (selected?.value) {
            const alias = await prompt("Alias (Enter para sugerirlo):");
            await addRepository(config, selected.value.path, alias || null);
            await writeUiConfig(configPath, config);
            notice = "Candidato añadido a la allowlist local.";
          }
        } else {
          const aliases = Object.keys(repositories);
          if (!aliases.length) throw new Error("No hay repositorios configurados.");
          const selected = await createRawMenu("Selecciona un repositorio", [...aliases.map((alias) => ({ label: `${alias} · ${active(repositories[alias]) ? "ACTIVO" : "INACTIVO"}`, value: alias })), { label: "Volver", value: null }], "");
          if (!selected?.value) continue;
          if (choice.value === "toggle") {
            setRepositoryEnabled(config, selected.value, !active(repositories[selected.value]));
            await writeUiConfig(configPath, config);
            notice = "Estado del repositorio guardado.";
          } else if (choice.value === "remove") {
            removeRepository(config, selected.value);
            await writeUiConfig(configPath, config);
            notice = "Repositorio eliminado de la configuración.";
          } else if (choice.value === "default") {
            setDefaultRepository(config, selected.value);
            await writeUiConfig(configPath, config);
            notice = "Repositorio predeterminado guardado.";
          }
        }
      } catch (error) {
        notice = `No se ha aplicado el cambio: ${error.message}`;
        await waitNotice();
      }
    }
  };
  const optionalMenu = async () => {
    while (true) {
      const optional = optionalOf(config);
      const bindings = Object.entries(optional.bindings).flatMap(([alias, binding]) => [
        binding.codebase_memory ? { label: `Codebase Memory · ${alias} · ${binding.codebase_memory.enabled === false ? "INACTIVO" : "ACTIVO"}`, value: [alias, "codebase_memory"] } : null,
        binding.context_mode ? { label: `Context Mode · ${alias} · ${binding.context_mode.enabled === false ? "INACTIVO" : "ACTIVO"}`, value: [alias, "context_mode"] } : null,
      ].filter(Boolean));
      const choice = await createRawMenu("Integraciones opcionales", [
        { label: `Autodescubrimiento: ${optional.auto_discover ? "ACTIVO" : "INACTIVO"}`, value: "auto" },
        ...bindings,
        { label: "Volver", value: "back" },
      ], "Solo se usan bindings explícitas y de solo lectura.");
      if (!choice || choice.value === "back") return;
      try {
        if (choice.value === "auto") setAutoDiscovery(config, !Boolean(optional.auto_discover));
        else setOptionalBackendEnabled(config, choice.value[0], choice.value[1], optional.bindings[choice.value[0]][choice.value[1]].enabled === false);
        await writeUiConfig(configPath, config);
        notice = "Configuración opcional guardada.";
      } catch (error) {
        notice = `No se ha aplicado el cambio: ${error.message}`;
        await waitNotice();
      }
    }
  };
  while (true) {
    const repositories = repositoriesOf(config);
    const choice = await createRawMenu("Configuración local", [
      { label: `Repositorios (${activeAliases(config).length} activos / ${Object.keys(repositories).length} configurados)`, value: "repos" },
      { label: "Integraciones opcionales", value: "optional" },
      { label: "Ejecutar doctor", value: "doctor" },
      { label: "Arrancar bridge local (Ctrl+C para parar)", value: "serve" },
      { label: "Salir", value: "exit" },
    ], notice);
    notice = "";
    if (!choice || choice.value === "exit") return;
    if (choice.value === "repos") await repositoryMenu();
    else if (choice.value === "optional") await optionalMenu();
    else if (choice.value === "doctor") {
      await runDoctor(configPath);
      await waitNotice();
    } else if (choice.value === "serve") {
      process.stdout.write("\nEl bridge local ocupará esta terminal. Pulsa Ctrl+C para detenerlo.\n");
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(packageRoot, "src", "server.mjs")], { env: { ...process.env, CODESCOPE_CONFIG: configPath }, stdio: "inherit", windowsHide: true });
        child.once("close", resolve);
        child.once("error", resolve);
      });
      notice = "El bridge ha terminado.";
    }
  }
}
