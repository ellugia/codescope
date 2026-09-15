# CodeScope workflow and order template

These are English instructions for a model-to-model handoff. The user-facing conversation must stay in the user's language.

## Conversation workflow

1. Confirm the user's goal and the read-only boundary.
2. Call `bridge_access_status` when session selection is enabled.
3. Show only repository aliases and ask the user to choose when selection is needed.
4. Call `bridge_access_select` for the chosen alias and show the security notice.
5. Inspect the smallest relevant set of files or Git views.
6. Separate observed facts, inferences, and blocked or untested items.
7. Stop before any write, external publication, credential handling, indexing, or backend administration.

## Order template

### Objective

Describe the behavior to inspect or change in one sentence.

### Authorized scope

- Repository alias or aliases selected for this conversation:
- Read-only tools needed:
- Optional backend, only if already advertised and bound:
- Files or symbols to inspect:

### Exclusions

- No writes, commits, checkout, reset, index changes, reindexing, or backend management.
- No unapproved roots, projects, worktrees, resources, prompts, sampling, or elicitation.
- No credentials, environment files, private keys, tokens, raw logs, or filesystem locations in the answer.

### Evidence required

- Current tool result or source excerpt:
- Reproduction or characterization:
- Security negative case, when relevant:
- Regression check after the change:

### Result format

Report:

1. `PASS`, `FAIL`, `BLOCKED`, or `NOT_RUN` for each requested check.
2. Files changed, with the reason for each change.
3. Evidence that the selected alias stayed within its configured root.
4. Tests run and any environmental limitation.
5. Remaining risk or decision required before publication.

Keep the explanation accessible and in the user's language. Tie conclusions to current evidence and state uncertainty plainly.
