# CodeScope

CodeScope is a local, read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) bridge for inspecting explicitly configured repositories. It gives an agent bounded filesystem and Git reads without accepting arbitrary paths, repository roots, or write operations from the conversation.

[Read this in Spanish](README.es.md) · [User guide](docs/user-guide.en.md) · [Guía de usuario](docs/user-guide.es.md)

## What it does

- maps short repository aliases to local absolute roots;
- reads UTF-8 files and bounded directory listings through an allowlist;
- reads Git status, history, references, and bounded diffs with helper execution disabled;
- keeps repository selection and session access explicit when that mode is enabled;
- exposes versioned advisory design guidance;
- can add Codebase Memory or Context Mode only when a repository-specific, read-only binding has been configured and validated;
- runs over local stdio by default. A tunnel is an optional deployment layer.

The bridge does not provide a general filesystem server, a Git write API, an arbitrary MCP proxy, or a public HTTP listener by default.

## Requirements

- Node.js 24.19 or newer;
- Git available as `git` or configured with an absolute executable path;
- a local configuration file containing one or more read-only repository entries.

## Quick start

From the project directory:

```powershell
npm ci
Copy-Item config.example.json config.json
```

Edit `config.json` and replace the example root with an absolute path on the local machine. Every repository must keep `read_only` set to `true`:

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

Start the local stdio server:

```powershell
$env:CODESCOPE_CONFIG = (Resolve-Path .\config.json).Path
node .\src\server.mjs
```

The process reads requests from stdio and writes protocol responses to stdout. Operational logs go to stderr. The bridge does not start a tunnel unless a separate launcher is explicitly used.

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
- tunnel credentials, if a deployment uses a tunnel, must come from the process environment or the tunnel client’s secret store rather than MCP arguments or repository files.

These controls are enforced by the bridge. MCP annotations such as `readOnlyHint` are descriptive metadata and are not used as an authorization mechanism.

## Checks

```powershell
npm run check
npm run doctor
```

`npm run check` creates and removes disposable test data and verifies filesystem, Git, cursor, limit, secret, and MCP-surface invariants. `npm run doctor` checks the configured repositories without starting a tunnel. Tests that exercise a separately launched bridge require `BRIDGE_COMMAND` and `BRIDGE_ARGS_JSON`; an unset harness is reported as blocked rather than silently passing.

## Windows launcher and TUI

The PowerShell TUI and launcher are optional Windows tooling. They use paths relative to the project or paths resolved from the current user’s environment; they do not require a particular Windows account name. Review the [English user guide](docs/user-guide.en.md) or the [Spanish user guide](docs/user-guide.es.md) before enabling a tunnel.

## Project status

The repository is in preproduction. The local bridge and its security checks are implemented, but a public release still requires a clean release checkout, a chosen license, a public repository URL, and an explicit decision about which internal fixtures, historical evidence, vendored dependencies, and managed local profiles are excluded from distribution.
