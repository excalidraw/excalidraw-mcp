# Excalidraw MCP App Server

MCP server that streams hand-drawn Excalidraw diagrams with smooth viewport camera control and interactive fullscreen editing.

![Demo](docs/demo.gif)

## Install

Use a client that supports [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) for the interactive diagram. Core-only clients receive a textual description and checkpoint handle. Optional host actions, such as fullscreen and external links, depend on the client. If something doesn't work, please [open an issue](https://github.com/excalidraw/excalidraw-mcp/issues).

### Remote (recommended)

### `https://mcp.excalidraw.com`

For apps that don't yet have an official integration, you can add a custom MCP / connector (naming can vary between apps).

The compatibility and storage details below describe this source build; the public service may run a different release.

### Local

**Option A: Download Extension**

1. Download `excalidraw-mcp-app.mcpb` from [Releases](https://github.com/excalidraw/excalidraw-mcp/releases)
2. Double-click to install in Claude Desktop

**Option B: Build from Source**

Requires **Node.js 22.15 or newer** and the pinned **pnpm 10.11.0** package manager. The build uses Bun, which the install script sets up from platform-specific optional dependencies.

```sh
git clone https://github.com/excalidraw/excalidraw-mcp.git
cd excalidraw-mcp
pnpm install --frozen-lockfile
pnpm run build
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw-mcp/dist/index.js", "--stdio"]
    }
  }
}
```

Restart Claude Desktop.

### Protocol compatibility

Version **0.4.0** includes the modern protocol and complete revisioned scene format. When upgrading from 0.3.x, use Node 22.15+, reload existing widgets before saving, and configure durable storage for Vercel (or explicitly select an ephemeral demo). Existing checkpoints remain readable; unrecoverable image bytes are reported rather than silently discarded.

| Surface | Behavior |
| --- | --- |
| Streamable HTTP, `/mcp` | MCP **2026-07-28** plus legacy stateless **2025-11-25** traffic; a fresh server for each request |
| stdio | Modern and legacy openings supported; stdout contains only JSON-RPC |
| HTTP sessions | No session IDs, standalone GET stream, session DELETE, or replay; GET/DELETE return 405 |
| Discovery and caching | Modern `server/discover`, request metadata/header validation, result envelopes, and cache hints are provided by the SDK's modern serving entry |
| MCP Apps | Independently initialized iframe protocol; optional host capabilities are not assumed |

The server uses the split TypeScript SDK v2 packages. The published Apps 1.x browser package retains its SDK v1 peer separately; it does not serve HTTP. Do not switch server imports back to that monolithic peer or share an SDK server/transport between HTTP requests.

### Local HTTP

```sh
node dist/index.js
```

The default address is `http://127.0.0.1:3001/mcp`. Use `PORT` to change the port. Exposing it beyond loopback requires explicit host configuration, for example in PowerShell:

```powershell
$env:EXCALIDRAW_HOST = "0.0.0.0"
$env:EXCALIDRAW_ALLOWED_HOSTS = "diagrams.example.com"
$env:EXCALIDRAW_ALLOWED_ORIGINS = "client.example.com"
node .\dist\index.js
```

Allow-lists contain comma-separated **hostnames**, without schemes, ports, or wildcards. Requests without an Origin header remain usable by native clients. A public listener requires an appropriately secured reverse proxy/TLS deployment.

## Usage

Example prompts:
- "Draw a cute cat using excalidraw"
- "Draw an architecture diagram showing a user connecting to an API server which talks to a database"

### Scenes, checkpoints, and exports

Call `read_me` for the compact element/operation format, then `create_view` with exactly one of:

- `elements`: a JSON array string of skeleton/native elements and ordered `cameraUpdate`, `delete`, or first-position `restoreCheckpoint` operations.
- `scene`: a JSON object string containing a complete native scene, including its `elements`, image `files`, and persistent `appState`.

Every successful creation returns `checkpointId` and `revision`. Restoring applies changes to the last acknowledged saved state, not unsaved edits. IDs must remain unique; deleting a container also removes its bound text.

Fullscreen editing preserves elements, image bytes, canvas appearance, and viewport in a versioned scene. Saves use revision checks: conflicts and errors are visible instead of silently replacing another edit. Old element-only checkpoints remain readable. Missing historical image bytes cannot be reconstructed; recovery is disclosed and the original record is not silently overwritten. Old widget versions must reload before writing the new revisioned format.

Use **Download .excalidraw** for a complete local file, including images. External sharing remains user-confirmed and uploads an encrypted shape/text scene to Excalidraw's existing sharing service. Image diagrams are rejected by that sharing endpoint with a local-download alternative: the public site's image sharing requires a separate asset service, so embedded files alone would be lost.

### Limits and privacy

HTTP requests are limited to **4 MiB including the JSON-RPC envelope and escaping**. Decoded scenes/checkpoints are limited to **5 MiB**, with at most 5,000 elements, 10,000 input operations, 100 image files, and 2 MiB decoded per image. Build large diagrams incrementally; a scene fitting the storage limit may still exceed an HTTP request limit.

Checkpoints are not encrypted at rest by this application. Treat checkpoint handles as sensitive: there is no built-in user-ownership/OAuth layer. Private or multi-tenant deployment requires authentication, checkpoint authorization, quotas, and a retention policy in front of the service. App-only tool visibility is not authentication.

The widget's HTML is bundled into one file, but runtime libraries, CSS, and fonts still load from the declared `esm.sh` CDN. It is not an offline/self-contained bundle.

## What are MCP Apps and how can I build one?

Text responses can only go so far. Sometimes users need to interact with data, not just read about it. [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/) is an official Model Context Protocol extension that lets servers return interactive HTML interfaces (data visualizations, forms, dashboards) that render directly in the chat.

- **Getting started for humans**: [documentation](https://modelcontextprotocol.io/docs/extensions/apps)
- **Getting started for AIs**: [skill](https://github.com/modelcontextprotocol/ext-apps/blob/main/plugins/mcp-apps/skills/create-mcp-app/SKILL.md)

## Contributing

### Agent skill

The maintained skill is in [`skills/excalidraw/SKILL.md`](skills/excalidraw/SKILL.md). It follows the current tool, checkpoint, image, and export contracts rather than the older file-only guide.

For a personal Copilot installation, place the complete skill directory at `~/.copilot/skills/excalidraw`, including `references/`. Preserve any personal `references/LOCAL_INSTALLATION.md` policy/path overlay when updating. Adding only the entry file with the CLI does not install its reference files.

A skill is guidance, not an MCP connection. Register the server separately, and start a new client session to reload updated instructions.

PRs welcome! See [Local](#local) above for build instructions and [CLAUDE.md](CLAUDE.md) for architecture and invariants.

```sh
pnpm test
pnpm run typecheck
pnpm run build
pnpm run test:dist
pnpm run dev:ui
```

The standalone UI includes an in-memory checkpoint mock. Transport tests explicitly exercise modern and legacy behavior; a default SDK client alone does not establish modern compatibility.

`pnpm run check` runs the suite, production build, and bundled-CLI checks together. npm publishing invokes this gate through `prepublishOnly`. A legacy element-array local cache is archived before conversion; unknown-revision recovery copies are download-only and cannot overwrite a newer server revision.

### Deploy your own instance

You can deploy your own copy to Vercel:

1. Fork this repo
2. Go to [vercel.com/new](https://vercel.com/new) and import your fork
3. Configure durable Redis storage using one of the credential pairs below
4. Your server will be at `https://your-project.vercel.app/mcp`

| Setting | Purpose |
| --- | --- |
| `KV_REST_API_URL` and `KV_REST_API_TOKEN` | Durable Upstash-compatible Redis REST storage |
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` | Alternative complete Redis credential pair |
| `EXCALIDRAW_STORAGE=memory` | Explicitly ephemeral demo mode only; records disappear across instances/cold starts |
| `EXCALIDRAW_ALLOWED_HOSTS` | Public/custom endpoint hostnames; Vercel deployment/production hostnames are defaults when available |
| `EXCALIDRAW_ALLOWED_ORIGINS` | Allowed browser-origin hostnames; defaults to the allowed endpoint hosts |
| `EXCALIDRAW_DATA_DIR` | Local file-store directory; not a substitute for shared storage on Vercel |

Vercel fails configuration rather than silently falling back to memory when Redis credentials are absent or incomplete. Redis checkpoints expire 30 days after the last successful write. Local storage uses the user's application-data directory (`%LOCALAPPDATA%\excalidraw-mcp\checkpoints` on Windows), keeps at most 100 checkpoints, and can read the previous temporary checkpoint location for migration. Memory mode also holds at most 100 checkpoints per instance.

Local writes use an atomic replacement and a directory write lock. A lock left by a crashed process is reported explicitly; remove it only after confirming no writer is running. Keep backups or local downloads for long-term retention.

`/api/mcp` remains an alias. The obsolete `/sse` and `/message` service is not provided. HTTP policy is shared with local serving rather than implemented through a separate sessionful wrapper.

### Release checklist

<details>
<summary>For maintainers</summary>

```bash
# 1. Bump version in manifest.json and package.json
# 2. Build and pack
pnpm run check && mcpb pack .

# 3. Create GitHub release
gh release create v0.3.0 excalidraw-mcp-app.mcpb --title "v0.3.0" --notes "What changed"

# 4. Deploy to Vercel
vercel --prod
```

</details>

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) — a virtual whiteboard for sketching hand-drawn like diagrams.

## License

MIT
