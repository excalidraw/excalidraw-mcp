---
name: excalidraw
description: Create and revise Excalidraw diagrams, architecture sketches, flowcharts, and data-flow illustrations using the Excalidraw MCP server or editable .excalidraw files. Use this skill whenever the user asks for Excalidraw, a hand-drawn diagram, checkpoint-based diagram edits, image-preserving diagram exports, or Excalidraw MCP setup and troubleshooting, even when they do not name the tool.
compatibility: Interactive views require Excalidraw MCP and an MCP Apps-capable host. File-only output needs local file tools. This server's local runtime requires Node.js 22.15 or newer.
---

# Excalidraw diagrams and MCP workflow

## Prerequisites and privacy

Read [local installation and policy](references/LOCAL_INSTALLATION.md) first. It may contain machine-specific paths and stricter organization rules. Do not infer permission to upload a diagram from the presence of a sharing tool or button.

Use the configured Excalidraw server's discovered tools; host-specific tool-name prefixes vary. The model-facing operations are `read_me` and `create_view`. Checkpoint read/save and external sharing tools are app-only implementation details, not ordinary model-authoring tools.

Keep confidential diagrams local or within an explicitly approved host/editor. The widget can send image/text context to its MCP host and loads static code/fonts from its declared CDN; this is distinct from uploading a diagram to a public sharing service.

## Choose the output route

| User needs | Route |
| --- | --- |
| Interactive diagram in a supporting host | MCP `read_me`, then `create_view` |
| Continue an existing MCP diagram | Its returned checkpoint handle, then ordered edits through `create_view` |
| Editable file, offline handoff, or a host without Apps UI | Native `.excalidraw` JSON or the widget's local download |
| Images that must survive export | A complete scene/files map and local `.excalidraw` download |
| Server setup or connection errors | Local installation reference, then inspect actual tools and runtime errors |

A successful tool result is not proof that an interactive view appeared. A terminal/core-only host may show only text and a checkpoint handle. Do not claim a file was saved or a screenshot was inspected unless that actually happened.

## MCP authoring

1. Discover the configured server and call `read_me` once before drawing. Its live reference is the authority for the running implementation; do not substitute a stale copied cheat sheet.
2. Use exactly one `create_view` argument: `elements` or `scene`. Both are **JSON strings**, not direct arrays/objects.
3. For generated diagrams, use `elements`: an ordered array of shapes, labels, arrows, and supported operations. Skeleton `label` properties are supported here and converted by the browser. Prefer them for centered container labels.
4. Start with a useful `cameraUpdate`, usually 800 by 600. Emit complete nodes progressively: shape/label, connections, then the next node. Choose readable text and leave room for labels.
5. For native/imported diagrams, use `scene`: preserve `elements`, image `files`, and intended persistent `appState`. Do not reinterpret native elements as skeletons or overwrite their chosen fonts.
6. Read the result's `checkpointId`, `revision`, and any `warnings`. Surface recovery or rendering limitations instead of reporting unconditional success.

See [MCP contracts and examples](references/MCP_WORKFLOW.md) for valid payloads, operation rules, and limits.

## Editing and persistence

Start an edit with the actual returned handle:

```json
[
  {"type":"restoreCheckpoint","id":"checkpoint-id-from-the-result"},
  {"type":"delete","ids":"old-node"},
  {"type":"rectangle","id":"replacement-node","x":100,"y":100,"width":180,"height":80,"label":{"text":"Updated node","fontSize":20}}
]
```

Replace the example handle and IDs with real values before calling. A restore must be first, and only one restore is permitted. IDs cannot be reused within an edit sequence, even after deletion. Delete only IDs that exist at that point; deleting a container removes its bound text.

Restoration uses the last **acknowledged saved revision**, not unsaved editor state. Read the widget's supplied edit context and save/conflict status when available. There is no guaranteed `read_widget_context` tool.

On a revision conflict, preserve/download local edits and reload deliberately. Do not retry by guessing a newer revision or bypassing comparison-and-swap. Legacy checkpoint reads remain supported; missing historical image bytes cannot be reconstructed. Preserve and disclose recovery warnings.

## Files, images, and export

The native `.excalidraw` file format and the server's checkpoint envelope are different. Native files contain `type: "excalidraw"` and `version: 2`; checkpoints use `schemaVersion: 1` and a revision. Do not place camera/delete/restore operations or skeleton-only labels in a portable native file.

For images, retain the matching `files[fileId]` entries throughout editing, save/load, and export. The current server intentionally rejects image diagrams from its external link-sharing endpoint: the public site fetches image assets through a separate service, so embedding files in that upload alone is insufficient.

Use a complete local `.excalidraw` download for images. Keep the source file alongside PNG/SVG derivatives. For authorized browser loading, use the browser's supported file chooser; do not attempt a localhost-fetch bridge through a site whose CSP forbids it.

Read [native scene and visual guidance](references/NATIVE_SCENES.md) before producing files without the widget.

## Errors and recovery

| Condition | Action |
| --- | --- |
| MCP tools unavailable | Say the server is not connected. Use file mode if suitable; do not invent tool results |
| Invalid JSON or scene shape | Correct the data and serialize once; do not repeatedly submit the same invalid payload |
| Checkpoint missing/expired | Use a retained file or recreate explicitly; do not pretend the old handle restored |
| Unsaved edits or revision conflict | Preserve a recovery copy and reload deliberately |
| Legacy missing-image warning | Explain which content is recoverable; do not fabricate image bytes or silently replace the original |
| Image link sharing blocked | Offer local `.excalidraw` download; do not route around the restriction |
| Host cannot edit, open links, or accept image context | Use supported actions and state the limitation |
| HTTP input too large | Reduce the request or use smaller checkpoint increments; account for JSON escaping |

## Output

Give the diagram/view or actual file path, a brief description, and any material recovery/host limitation. Include the checkpoint handle when it is useful for a follow-up. Avoid dumping the whole elements array unless requested.

## Post-run reflection

Check whether the requested state, labels, files, and export were actually delivered. Confirm warnings and unsaved state were not hidden. If the running server differs from these references, use its live `read_me` and update the source skill deliberately rather than guessing.

## References

| Reference | Read when |
| --- | --- |
| [Local installation and policy](references/LOCAL_INSTALLATION.md) | At the start, and for connection/setup questions |
| [MCP workflow](references/MCP_WORKFLOW.md) | Building requests or interpreting checkpoint behavior |
| [Native scenes](references/NATIVE_SCENES.md) | Writing files, working with images/fonts, or exporting |
