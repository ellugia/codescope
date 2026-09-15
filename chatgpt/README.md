# ChatGPT integration files

The files in this directory are portable, model-facing instructions for using CodeScope from a ChatGPT project. They contain no local paths, credentials, exported conversations, or machine-specific validation records.

Keep every user-facing conversation in the language used by the user unless the user asks for another language.

Use the Node CLI and terminal UI for local setup and operation. PowerShell launchers, tunnel scripts, and remote authentication are outside the supported release.

The UI is for local configuration and diagnostics; the `serve` command owns the MCP stdio bridge. Keep the conversation in the user's language.
