# ChatGPT integration files

The files in this directory are portable, model-facing instructions for using CodeScope from a ChatGPT project. They contain no credentials or exported conversations.

The main file to paste into a ChatGPT Project's **Instructions** field is
[`project-instructions.md`](project-instructions.md). With the normal local
installation, run this from the installation directory:

```sh
node node_modules/@ellugia/codescope/bin/codescope.mjs instructions
```

If `codescope` is already available as a command, `codescope instructions` is
equivalent. The repository README files describe the complete setup.

Keep every user-facing conversation in the language used by the user unless the user asks for another language.

Use the Node CLI and terminal UI for setup and operation. The `serve` command
owns the MCP stdio bridge.

The UI is for configuration and diagnostics. Keep the conversation in the user's language.
