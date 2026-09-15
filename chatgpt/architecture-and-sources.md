# CodeScope architecture and source map

This document is model-facing reference material. It is intentionally written in English; the conversation with the user must remain in the user's language.

## Trust boundary

The MCP server is a local stdio process. `src/server.mjs` owns transport and protocol handling. `src/bridge.mjs` owns the positive tool allowlist, configuration normalization, repository alias resolution, session access, path checks, secret filtering, bounded output, signed cursors, and Git invocation. `src/optional-backends.mjs` adapts explicitly bound optional integrations and keeps their results read-only and filtered. `src/optional-discovery.mjs` performs inspection-only installation discovery.

Local stdio is the only supported transport in this release. The bridge does not expose a public listener.

The Node CLI manages local configuration and diagnostics; `serve` remains the MCP stdio bridge. With the normal local install, invoke it as `node node_modules/codescope/bin/codescope.mjs <command>` from the installation directory. The shorter `codescope <command>` form is equivalent when the package bin is on `PATH`.

## Configuration flow

1. `loadConfig` honors an explicit path and `CODESCOPE_CONFIG`, then uses an existing platform user configuration, an existing local `config.json` for compatibility, or the platform user configuration path for a new setup.
2. `normalizeConfig` requires absolute repository roots and `read_only: true`, validates limits, and normalizes optional repository bindings.
3. `attachOptionalDiscovery` may add validated optional installations without starting them or reading credentials.
4. A bridge call validates the tool name, arguments, session, and selected alias before resolving a canonical repository root.

Repository paths are configuration data, not MCP arguments. A call may name an alias but may not choose a new root, project, worktree, URI, or storage directory.

## Base read policy

Filesystem operations reject traversal, alternate Windows root forms, symlinks, reparse points, hard-linked files, `.git`, environment files, credentials, private keys, certificates, and matching secret content. Reads are bounded and paginated. A response never exposes content collected after a secret or identity check fails.

Git runs without a shell, terminal prompts, global or system configuration, external diff helpers, or text converters. The selected canonical root is passed as the only `safe.directory` value. Diffs require an immutable full reference and are inspected before a page is returned.

MCP resources, prompts, sampling, elicitation, hidden tools, and write operations are outside the positive surface and must remain rejected even if a client calls them directly.

## Optional integrations

Codebase Memory and Context Mode are opt-in per repository. Their binding must match the repository root and constrain project, source, corpus, storage, command, and session data. Autodiscovery only checks known paths. It does not index, execute arbitrary commands, or create a binding. Optional tools stay out of the catalog when their binding is disabled or not ready.

Ponytail is an optional source of advisory instructions. `design_guidance` is the built-in, versioned policy and remains available without Ponytail.

## Evidence discipline

Use the active tool result as the source of truth. Label untested integrations, unavailable installations, stale metadata, and environmental test blocks explicitly. Tie each claim to current evidence and state uncertainty plainly.

## Relevant files

- `src/server.mjs`: stdio MCP entrypoint.
- `bin/codescope.mjs`: Node CLI and terminal UI entrypoint.
- `src/tui.mjs`: interactive Node terminal UI.
- `src/bridge.mjs`: security boundary and tool dispatch.
- `src/optional-backends.mjs`: filtered optional-backend adapters.
- `src/optional-discovery.mjs`: side-effect-free optional discovery.
- `config.example.json`: safe configuration shape with optional backends disabled.
- `docs/user-guide.en.md` and `docs/user-guide.es.md`: public user documentation.

Do not expose fixtures, machine-specific profiles, credentials, process IDs, or test output in model responses.
