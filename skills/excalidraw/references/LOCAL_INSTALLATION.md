# Local installation and policy

This is the portable source template. A personal installation may replace this file with machine-specific paths and stricter organization policy; keep those private details out of the public repository.

For this server, use Node22.15+ and an absolute path to the built `index.js`, with `--stdio`. The MCP client starts the process on demand. A runtime copied outside a temporary worktree remains usable when that worktree is removed.

Local mode stores checkpoints in user application data and does not require Redis, an API key, a public deployment, or a continuously running HTTP process.

For Copilot CLI, inspect its installed `copilot mcp add --help` and existing configuration rather than trusting copied commands for another client/version. Personal skills live at `~/.copilot/skills/excalidraw/SKILL.md`; include this skill's references directory, not just the entry file.

Never overwrite unrelated MCP server entries. Do not enable unrestricted tool permissions as part of setup. A skill provides instructions; it does not itself register an MCP server.

Keep diagrams local by default. Follow organization policy for approved hosts/editors and data handling. External sharing requires both policy permission and explicit user consent; a server tool or button is not consent.
