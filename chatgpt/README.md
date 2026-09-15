# ChatGPT integration files

The files in this directory are portable, model-facing instructions for using CodeScope from a ChatGPT project. They contain no credentials or exported conversations.

The main file to paste into a ChatGPT Project's **Instructions** field is
[`project-instructions.md`](project-instructions.md). After a global install,
run this from any folder:

```sh
codescope instructions
```

After a local install, run it from the installation directory with npx:

```sh
npx codescope instructions
```

The repository README files describe the complete setup.

Keep every user-facing conversation in the language used by the user unless the user asks for another language.

Use the Node CLI and terminal UI for setup and operation. The `serve` command
owns the MCP stdio bridge.

The UI is for configuration and diagnostics. Keep the conversation in the user's language.
