# CodeScope

CodeScope helps you use a regular ChatGPT conversation or ChatGPT Project to understand code that stays on your own computer. Install it once, choose the repositories you want to make available, and ask questions in plain language about files, Git history, structure, and design. The intended workflow is to use the quota of that regular ChatGPT conversation for the analysis, rather than ChatGPT Work or Codex. CodeScope only supplies bounded, read-only context from the repositories you select.

Whether you are joining an unfamiliar codebase, tracing a bug, reviewing a change, or deciding what to work on next, CodeScope gives the conversation a safe window into the repositories you selected instead of asking you to upload them or grant write access.

Under the hood, CodeScope is a local, read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) bridge for explicitly configured repositories. It gives an agent bounded filesystem and Git reads without accepting arbitrary paths, repository roots, or write operations from the conversation.

[Read this in Spanish](README.es.md) · [User guide](docs/user-guide.en.md) · [Guía de usuario](docs/user-guide.es.md)

## Development note

CodeScope was primarily developed with assistance from ChatGPT 5.6 Luna Max.

## What it does

- maps short repository aliases to local absolute roots;
- reads UTF-8 files and bounded directory listings through an allowlist;
- reads Git status, history, references, and bounded diffs with helper execution disabled;
- keeps repository selection and session access explicit when that mode is enabled;
- exposes versioned advisory design guidance;
- can add Codebase Memory or Context Mode only when a repository-specific, read-only binding has been configured and validated;
- runs over local stdio. Local mode is the only supported transport in this release.

The bridge does not provide a general filesystem server, a Git write API, an arbitrary MCP proxy, or a public HTTP listener by default.

## Requirements

- Node.js 24.19 or newer;
- Git available as `git` or configured with an absolute executable path;
- a local configuration file containing one or more read-only repository entries.

## Quick start

Choose one of the two installation routes below. Each command is in its own
code block so it can be copied independently.

### Option A: global install

Use this route when you want the `codescope` command to work from any folder:

```sh
npm install --global @ellugia/codescope
```

Then run the guided setup:

```sh
codescope setup
```

### Option B: local install with npx

Use this route when you do not want a global npm installation:

```sh
npm install @ellugia/codescope
```

Then run the setup through the local package:

```sh
npx codescope setup
```

Do not use both routes for the same installation. Both routes create the same
per-user configuration.

`setup` creates the user configuration, opens the terminal UI so you can add
repositories and optional integrations, and offers to register CodeScope in
Codex. It keeps the configuration in the platform configuration directory:
`%APPDATA%\CodeScope` on Windows, `~/Library/Application Support/CodeScope`
on macOS, or `$XDG_CONFIG_HOME/codescope` (usually `~/.config/codescope`) on
Linux. Use `--config ./config.json` or `CODESCOPE_CONFIG` only when you
explicitly want another location.

To configure the ChatGPT project that will use the MCP, copy the contents of
[`chatgpt/project-instructions.md`](chatgpt/project-instructions.md) into its
**Instructions** field. The file gives the agent the recommended
repository-selection and safety workflow.

The bridge still enforces access on its own, so these instructions improve the
interaction but are not the security boundary.

If you use `init` for template-only setup, edit the configuration file it prints
and replace the example root with an absolute path on the local machine. Every
repository must keep `read_only` set to `true`:

```json
{
  "git_binary": "git",
  "default_repository": "main",
  "repositories": {
    "main": {
      "root": "C:/path/to/repository",
      "read_only": true
    }
  },
  "optional_backends": {
    "auto_discover": false,
    "bindings": {}
  }
}
```

The terminal UI can mark a configured repository with `enabled: false` without deleting it. Disabled entries stay in the local file but are not exposed by the bridge. The UI also preserves and toggles configured read-only Codebase Memory and Context Mode bindings; it does not invent a backend path.

Start the local stdio server:

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs serve
```

The process reads requests from stdio and writes protocol responses to stdout. Operational logs go to stderr. Local mode does not start a tunnel, open a network listener, or require an OpenAI API key.

## npm command

The package includes a small Node CLI. From a checkout:

```sh
npm install .
```

Then run the local CLI with npx:

```sh
npx codescope setup
```

`setup` creates the user configuration when needed and opens the guided TUI. `init` remains available for scripted/template-only setup, and `serve` starts the same stdio bridge as `node src/server.mjs`. Pass `--config ./config.json` to keep the configuration beside the current project instead.

For interactive local configuration and diagnostics, run `node node_modules/@ellugia/codescope/bin/codescope.mjs ui`. The UI manages local setup; `serve` remains the MCP stdio bridge.
The UI can also run `serve` in the foreground for a local smoke check; press `Ctrl+C` to stop it. An MCP host normally starts `serve` itself.

The npm package deliberately excludes `deps/`, managed profiles, caches, test evidence, Windows launchers, and real repository content.

`codex-repositories` is an import helper for the local setup flow:

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs codex-repositories
```

It reads only `CODEX_HOME/config.toml`. When `CODEX_HOME` is not set, it checks `~/.codex/config.toml` on Linux and macOS, and the equivalent user-home `.codex/config.toml` on Windows. It extracts `[projects.'...']` and `[projects."..."]` entries as candidates. The user must still choose which candidates to copy into CodeScope's own configuration; a Codex project entry never grants repository access by itself.

## Repository and session access

Repository paths never come from an MCP call. The call supplies an alias such as `main`; the configuration resolves that alias to the approved root. When `session_access.mode` is `session_select`, the client must first show the available aliases with `bridge_access_status` and then explicitly select the alias with `bridge_access_select`. A session can release one alias or reset all selections.

The model-facing instructions in [`chatgpt/`](chatgpt/) are written in English so they are portable between hosts. They explicitly require the agent to keep the user-facing conversation in the user’s language.

## Available tools

The base catalog contains read-only filesystem and Git tools plus `design_guidance`. The exact catalog is returned by MCP `tools/list` for the active configuration. Optional tools are advertised only after their repository binding has passed validation.

| Area | Examples |
| --- | --- |
| Filesystem | `fs_read_text`, `fs_list`, `fs_find`, `fs_search_content` |
| Git | `git_status`, `git_head`, `git_ref`, `git_log`, `git_diff`, `git_diff_staged`, `git_diff_unstaged` |
| Design | `design_guidance` |
| Optional, opt-in | `cbm_status`, `cbm_search`, `cbm_trace`, `cbm_snippet`, `context_mode_search` |

All results are bounded by byte, entry, line, match, depth, timeout, and concurrency limits. Large reads and diffs use signed continuation cursors. Unknown tools, hidden write tools, resources, prompts, sampling, and elicitation are rejected.

## Optional integrations

Codebase Memory and Context Mode are optional. Autodiscovery only checks known local installation paths; it does not start a process, index a repository, read credentials, or create a binding. To expose an optional backend, configure it for a specific repository alias, set it to read-only, and restrict its project, root, corpus, and storage paths to that repository. If the binding is not ready, the optional tool stays unavailable while the base filesystem and Git tools continue to work.

Ponytail instructions are also optional and are advertised only after the local installation passes its marker checks. Design guidance remains available without Ponytail.

## Security boundary

- repository roots are absolute, configured locally, and checked again before access;
- traversal, alternate root syntaxes, symlinks, reparse points, hard-linked files, and protected paths are rejected;
- `.git`, environment files, credentials, private keys, certificates, and matching secret content are denied or redacted;
- Git runs without a shell, terminal prompts, external diff helpers, or text converters, and scopes `safe.directory` to the selected canonical root;
- no repository write operation is exposed;
- the bridge makes no network connection in local mode; repository access comes only from its local configuration.

These controls are enforced by the bridge. MCP annotations such as `readOnlyHint` are descriptive metadata and are not used as an authorization mechanism.

## Checks

```sh
node scripts/self-check.mjs
node scripts/doctor.mjs
```

`scripts/self-check.mjs` creates and removes disposable test data and verifies filesystem, Git, cursor, limit, secret, and MCP-surface invariants. `scripts/doctor.mjs` checks the configured repositories without starting another service. Tests that exercise a separately launched bridge require `BRIDGE_COMMAND` and `BRIDGE_ARGS_JSON`; an unset harness is reported as blocked rather than silently passing.

## Local command surface

The Node CLI and terminal UI are the supported local command surface on Windows, Linux, and macOS. With the normal local install, use `node node_modules/@ellugia/codescope/bin/codescope.mjs <command>` for manual setup, serving, diagnostics, and Codex repository discovery. The shorter `codescope <command>` form is equivalent when the package bin is already on your `PATH`. PowerShell launchers, tunnel scripts, and remote authentication are outside this release.

## Project status

The release scope is local-only. Before publishing, run `npm pack --dry-run` and complete a local stdio canary on the supported operating systems. No tunnel or remote authentication is part of this release.

## License

CodeScope is released under the [MIT License](LICENSE). You may use, modify,
and redistribute it while retaining the copyright and license notice.
