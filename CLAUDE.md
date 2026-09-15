# Excalidraw MCP App Server

MCP server with streamed SVG previews, interactive fullscreen editing, and revisioned scene checkpoints.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/server.ts` | Shared tool/resource registration, input validation, checkpoint operations, shape-only sharing |
| `src/http.ts` | Modern SDK HTTP factory, explicit legacy fallback, Host/Origin/CORS and request limits |
| `src/main.ts` | Bounded local Express/Node adapter and modern/legacy stdio entry |
| `api/mcp.ts` | Vercel entry using the same HTTP policy and fresh-instance factory |
| `src/scene.ts` | Browser/server-safe JSON scene schema, legacy recovery, ordered operation reducer |
| `src/checkpoint-store.ts` | Revision-safe memory/file/Redis stores and explicit legacy migration |
| `src/mcp-app.tsx` | SVG preview, fullscreen editor, host-aware controls, downloads and model feedback |
| `src/app-events.ts` | Pre-connect event buffering |
| `src/edit-context.ts` | Widget-scoped scene/cache/save lifecycle |
| `src/widget-scene.ts` | Browser-native scene conversion |
| `src/metadata.ts` | Shared identity derived from package metadata |
| `runtime-assets.ts` | Version-derived CDN import map and Excalidraw asset path |
| `src/dev.tsx`, `src/dev-mock.ts` | Standalone UI and stateful mock host |
| `tests/` | Scene/store, widget lifecycle, tool, modern/legacy HTTP and stdio regressions |

## MCP transport invariants

- HTTP uses SDK v2 `createMcpHandler(factory)`. The factory must return a **new server per request**. Never share a transport or connected server between clients.
- Durable scene stores may be shared outside the factory; scene IDs are explicit application state, not MCP session IDs.
- stdio uses `serveStdio(factory)`, not a direct legacy-only `connect(StdioServerTransport)`.
- Keep modern 2026-07-28 and explicit legacy 2025-11-25 compatibility separate in tests.
- Let the modern SDK encode discovery, request metadata, result discriminators, cache hints, and protocol errors. Do not patch version constants or synthesize partial compliance.
- The monolithic SDK v1 dependency exists only for the published Apps browser peer. Server transport and registration import the split v2 packages directly.
- Apps `ui/initialize` is independent of core MCP version negotiation.
- Register Apps notification handlers **before connect**, through `onAppCreated`, and retain input before the child UI mounts.
- stdout is exclusively JSON-RPC in stdio mode. Server diagnostics go to stderr.

## Tools and resources

`read_me` returns the authoring reference. `create_view` takes exactly one JSON string: an `elements` operation array or a complete `scene` object. Its structured result includes `checkpointId`, `revision`, and optional recovery warnings; its text content must remain useful without the UI.

App-only tools:

- `read_checkpoint`: full scene/revision, with explicit recovery metadata when old image bytes are unavailable.
- `save_checkpoint`: complete schema-versioned scene plus `expectedRevision`; missing expectations fail safely.
- `export_to_excalidraw`: user-confirmed shape/text upload with a request abort/deadline. Reject image scenes rather than returning an incomplete share URL.

UI resource: `ui://excalidraw/mcp-app.html`, MIME `text/html;profile=mcp-app`.

CSP, border preference, and permission requests belong on `contents[i]._meta.ui` in the **resource-read response**, not just registration metadata. Keep the compatibility resource-URI alias alongside the current nested metadata while supporting legacy hosts. Tool visibility is not access control. Permissions and optional host methods can be denied.

## Scene contract

The canonical envelope contains `schemaVersion: 1`, elements, image files, a serializable appState whitelist, and optional viewport. Stored checkpoints add a revision.

- Skeleton labels remain supported via browser conversion. Native scene import/restoration must preserve explicit font choices and binary files.
- Camera, delete, and restore instructions are operations, not native drawing elements. Do not store them in the final editor/export scene.
- Use the shared ordered reducer for server and preview semantics.
- Never reuse an element ID within a scene operation sequence, even after deletion.
- Remove a deleted container's bound text and repair dangling references.
- Keep animation placeholders out of final state and exports.
- Empty scenes are valid and must survive reload.
- Validate decoded JSON shape, geometry, bindings, file references, depth/count limits, and actual UTF-8 bytes.
- HTTP request limits include the enclosing JSON-RPC and string-escaping overhead. They differ from stored-scene limits.

## Persistence and migration

`save(id, scene)` / expectation zero are **create-only**. Positive expectations compare-and-swap and increment the revision. `migrate(id, scene)` updates only an existing legacy revision-zero checkpoint.

The update tool must route `expectedRevision === 0` to `migrate`, not create-only `save`. Old unversioned writers must reload rather than clobbering complete new scenes.

File writes use atomic replacement under a cross-process directory lock. Distinguish not-found from corrupt/unreadable data. Redis uses an atomic compare-and-swap script, not a process-local lock. Never test against user checkpoints; use owned temporary directories or injected clients.

Production Vercel requires durable storage unless `EXCALIDRAW_STORAGE=memory` explicitly selects an ephemeral demo. Both Redis URL and token are required. Never print credentials.

Legacy missing-file recovery preserves the original record and discloses unavailable images. Do not silently migrate an incomplete recovered scene over the source. A new recovery checkpoint must include a warning.

Keep widget save state scoped to its instance: acknowledge revisions, expose dirty/saving/error/conflict status, inspect `isError`, and retain recoverable unsaved state. Never blindly retry a revision conflict. Teardown flushing is best-effort because the host need not wait forever.

Treat save rejections as `unknown`, including null and non-Error values. Protect local edits from both new tool input and its later result. A new invocation cannot inherit the previous checkpoint's readiness, and delayed model feedback must retain the acknowledged checkpoint ID alongside its scene and revision.

## Rendering and exports

Use `exportToSvg` plus morphdom for inline previews; mount the Excalidraw React editor only in fullscreen. Do not introduce another remounting render path for every stream chunk.

Render according to scene/camera revision, not element count alone. Coalesce async work and discard stale completions. Use native bounds and preserve stable identities. Fonts must be ready before measuring or exporting.

`skipInliningFonts` is appropriate only when the preview's font resources remain available. Standalone/raster exports need their own correct font handling.

Editor `onChange` supplies elements, appState, and files: preserve all supported scene data across preview, persistence, reload, and export. Model feedback must include meaningful text/style changes as well as geometry, and must not claim unsaved edits are durable.

Skeleton conversion can drop explicit arrow bindings; preserve validated `startBinding`/`endBinding` and reconcile reciprocal bound elements before native restoration. Freehand elements require nonempty point geometry before a successful checkpoint is acknowledged.

Use a files-preserving local `.excalidraw` download for images. Excalidraw's `"database"` serializer strips files, and its sharing site loads image assets separately. Do not assume adding a files map to that upload implements image sharing.

Keep external upload confirmation, mobile safe-area layout, visible keyboard focus, modal focus/escape behavior, and reduced-motion/audio controls.

Widget diagnostics use `app.sendLog(...)` through the host, not `console.log`. Surface actionable rendering/storage/sharing failures; do not hide them behind empty success.

## Build and development

Requires Node 22.15+ and pinned pnpm 10.11.0. Bun is provisioned through the existing optional-dependency setup.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm run test:dist
pnpm run dev:ui
```

Build: type-check -> Vite single-file HTML -> declarations -> Bun server/CLI bundles.

`pnpm run check` is the combined release gate and runs automatically before npm publishing. Preserve legacy local cache bytes before conversion, and never restore an unknown-revision recovery copy over a server checkpoint.

The TypeScript check includes the API route and build configuration. Source tests use Node's built-in test runner/type stripping; the test-only import hook resolves production `.js` imports to local `.ts`.

Production and dev browser versions come from pinned package metadata. HTML is a single file but still depends on its declared CDN assets; do not describe it as offline. Exercise the production build and cold asset loading as well as the mock UI.

Restart a running server after tool-definition changes. `pnpm run dev` watches the server and UI build; `pnpm run dev:ui` exercises the widget without an MCP host.

## Scope

Do not add optional sampling, roots, prompts, subscriptions, tasks, multiplayer, or authentication without a product requirement. Private multi-tenant deployment does require an ownership/authorization design; an anonymous public demo does not automatically require OAuth.
