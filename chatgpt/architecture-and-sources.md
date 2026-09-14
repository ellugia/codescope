# CodeScope architecture and source map

This document is model-facing reference material. It is intentionally written in English; the conversation with the user must remain in the user's language.

## Trust boundary

The MCP server is a local stdio process. `src/server.mjs` owns transport and protocol handling. `src/bridge.mjs` owns the positive tool allowlist, configuration normalization, repository alias resolution, session access, path checks, secret filtering, bounded output, signed cursors, and Git invocation. `src/optional-backends.mjs` adapts explicitly bound optional integrations and keeps their results read-only and filtered. `src/optional-discovery.mjs` performs inspection-only installation discovery.

The tunnel, when enabled by a separate launcher, is transport. It does not replace the bridge's authorization, repository allowlist, session selection, secret filtering, or read-only checks.

## Configuration flow

1. `loadConfig` reads the path from `CODESCOPE_CONFIG` or the local `config.json`.
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

Use the active tool result as the source of truth. Label untested integrations, unavailable installations, stale metadata, and environmental test blocks explicitly. Do not use historical validation records, host snapshots, local configuration files, or managed runtime profiles as proof of a current public deployment.

## Relevant files

- `src/server.mjs`: stdio MCP entrypoint.
- `src/bridge.mjs`: security boundary and tool dispatch.
- `src/optional-backends.mjs`: filtered optional-backend adapters.
- `src/optional-discovery.mjs`: side-effect-free optional discovery.
- `config.example.json`: safe configuration shape with optional backends disabled.
- `scripts/codescope-tui.ps1`: optional Windows profile/TUI operations.
- `scripts/codescope-launch.ps1`: optional local launcher and health check.
- `docs/user-guide.en.md` and `docs/user-guide.es.md`: public user documentation.

Do not expose internal fixtures, machine-specific profiles, credentials, tunnel identifiers, process IDs, or historical evidence in model responses.
