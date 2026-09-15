# CodeScope user guide

This guide describes the public-facing workflow. Host-specific validation records and managed local profiles are maintainer material and are not part of this guide.

## 1. Configure repositories

Copy `config.example.json` to `config.json` and give every repository a short alias, an absolute root, and `read_only: true`. The alias is the only repository selector accepted by MCP calls. The bridge rejects a path or project supplied as a free-form root.

Keep `config.json` outside version control when it contains local paths. Set `CODESCOPE_CONFIG` to its absolute path before starting the server.

The terminal UI can disable a repository with `enabled: false` while retaining its entry for later reactivation. The bridge exposes only enabled entries and always requires `read_only: true`.

## 2. Start the bridge

```sh
npx codescope serve --config ./config.json
```

The server uses stdio. Connect it from an MCP client that can launch local stdio servers. Do not add a public HTTP listener to the bridge to work around a client limitation.

The npm CLI provides the same flow without relying on a vendored runtime:

```sh
npx codescope init --config ./config.json
npx codescope serve --config ./config.json
```

Local mode does not require a tunnel client or an OpenAI API key. The package contains no vendored runtime, managed profile, local cache, or Windows launcher.

The Node CLI and terminal UI are the supported local interface on Windows, Linux, and macOS. Use `npx codescope ...` for setup, serving, diagnostics, and Codex repository discovery. PowerShell launchers and tunnel scripts are outside this release.

For interactive local configuration and diagnostics, run:

```sh
npx codescope ui --config ./config.json
```

The UI manages local setup and diagnostics; `serve` remains the MCP stdio bridge.
The UI can also run `serve` in the foreground for a local smoke check; press `Ctrl+C` to stop that process. An MCP host normally starts `serve` itself.

## 3. Import candidates from Codex

`npx codescope codex-repositories` reads `CODEX_HOME/config.toml`, or `~/.codex/config.toml` when the variable is not set. It extracts Codex `[projects.'...']` and `[projects."..."]` entries and prints candidate folders. This is only a discovery list: the user must select candidates and copy them into CodeScope's own configuration. CodeScope never treats Codex's project list as authorization.

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

- Never ask the bridge to read a repository root, absolute path, `.git` directory, environment file, credential, private key, certificate, or token file.
- Never request writes, commits, checkout, reset, index changes, reindexing, or backend management operations.
- Never invent an alias, session ID, project name, root, revision, or optional-backend binding.
- Do not expose local absolute paths, process IDs, credentials, or internal validation artifacts in the user-facing answer.
- Distinguish observed tool output, inference, and blocked or untested behavior.
- Keep the conversation in the user’s language. These English instructions do not override the user’s language.

## 8. Troubleshooting

- `config_missing`: pass `--config`, set `CODESCOPE_CONFIG`, or place a local `config.json` in the current working directory.
- `repository_access_required` or `session_required`: select a configured alias in the current session.
- `path_denied` or `secret_denied`: the requested path or content is outside the public read policy.
- `backend_unavailable`: the optional backend is absent, disabled, or not bound to this repository.
- A test that says `BRIDGE_COMMAND` is missing is a harness configuration issue; it is not evidence that the bridge security test passed.
