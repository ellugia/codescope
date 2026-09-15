# CodeScope user guide

This guide explains the supported public workflow.

## 1. Configure repositories

Install `codescope` in the current project with npm:

```sh
npm install codescope
```

The installer asks whether to launch the guided setup immediately; answering yes creates the user configuration and opens the terminal UI. Add every repository with a short alias, its repository folder, and `read_only: true`. The alias is the only repository selector accepted by MCP calls. The bridge rejects a path or project supplied as a free-form root. After the TUI, setup can register CodeScope in Codex; it never replaces an existing `codescope` entry.

Some npm security policies suppress package scripts or run them without an interactive terminal. In that case the package still installs normally; use the direct Node setup command from the next section.

Use `--config <file>` or `CODESCOPE_CONFIG` when you need a custom configuration file. Keep that file private when it contains machine-specific settings.

The terminal UI can disable a repository with `enabled: false` while retaining its entry for later reactivation. The bridge exposes only enabled entries and always requires `read_only: true`.

## 2. Start the bridge

The normal npm installation is local. For manual commands in this guide, use
the package entrypoint below from the installation directory:

```sh
node node_modules/codescope/bin/codescope.mjs <command>
```

If `codescope` is already on your `PATH`, its shorter form is equivalent.

```sh
node node_modules/codescope/bin/codescope.mjs serve
```

The server uses stdio. Connect it from an MCP client that can launch local stdio servers. Do not add a public HTTP listener to the bridge to work around a client limitation.

For scripted setup without the UI, the npm CLI also provides:

```sh
node node_modules/codescope/bin/codescope.mjs init
node node_modules/codescope/bin/codescope.mjs serve
```

Local mode works without an extra service or API credential. The package provides the supported Node CLI and terminal UI directly.

The Node CLI and terminal UI are the supported interface on Windows, Linux, and macOS. With the normal local install, use `node node_modules/codescope/bin/codescope.mjs <command>` for setup, serving, diagnostics, and Codex repository discovery. The shorter `codescope <command>` form is equivalent when the package bin is on your `PATH`.

For interactive local configuration and diagnostics, run:

```sh
node node_modules/codescope/bin/codescope.mjs ui
```

The UI manages local setup and diagnostics; `serve` remains the MCP stdio bridge.
The UI can also run `serve` in the foreground for a local smoke check; press `Ctrl+C` to stop that process. An MCP host normally starts `serve` itself.

## 3. Import candidates from Codex

`node node_modules/codescope/bin/codescope.mjs codex-repositories` reads the Codex configuration, extracts its project entries, and prints candidate folders. This is only a discovery list: the user must select candidates and copy them into CodeScope's own configuration. CodeScope never treats Codex's project list as authorization.

## 4. Select the repository for a conversation

If session selection is enabled, the agent calls `bridge_access_status`, shows the configured aliases in the chat, and asks which alias the user wants to use. The agent then calls `bridge_access_select` for that alias. Every repository tool call includes the selected alias. The agent must show a short security notice when the selection changes: the conversation can read only the selected, configured, read-only repository until it is released or the session expires.

If the agent has no session metadata or the user has not selected an alias, the bridge must fail closed. It must not guess from a path mentioned in the conversation.

## 5. Use the base tools

Use filesystem tools for bounded file reads and searches. Use Git tools for repository state, immutable references, history, and diffs. Use `design_guidance` when the user asks for the project’s advisory design policy.

Treat `truncated: true`, a continuation cursor, a redaction count, or a denied result as part of the answer. Do not present a partial result as a complete repository read.

## 6. Use optional backends

Codebase Memory and Context Mode are opt-in per repository. They must be configured with matching roots, read-only flags, bounded source/corpus paths, and a validated installation. Autodiscovery is a read-only check and does not create a binding. If the installation is missing or the binding is not ready, explain that the optional context is unavailable and continue with filesystem/Git when appropriate.

Ponytail instructions are advisory and optional. Their absence must not disable the base bridge or design guidance.

## 7. Security rules for the agent

- Never ask the bridge to read outside a configured repository or to read `.git`, environment files, credentials, private keys, certificates, or token files.
- Never request writes, commits, checkout, reset, index changes, reindexing, or backend management operations.
- Never invent an alias, session ID, project name, root, revision, or optional-backend binding.
- Do not expose filesystem locations, process IDs, credentials, or test artifacts in the user-facing answer.
- Distinguish observed tool output, inference, and blocked or untested behavior.
- Keep the conversation in the user’s language. These English instructions do not override the user’s language.

## 8. Troubleshooting

- `config_missing`: run `node node_modules/codescope/bin/codescope.mjs setup` from the installation directory. You can also pass `--config` or set `CODESCOPE_CONFIG`. An existing `config.json` in the current working directory is still supported for compatibility.
- `repository_access_required` or `session_required`: select a configured alias in the current session.
- `path_denied` or `secret_denied`: the requested path or content is outside the public read policy.
- `backend_unavailable`: the optional backend is absent, disabled, or not bound to this repository.
