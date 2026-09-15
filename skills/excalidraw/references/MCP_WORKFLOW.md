# MCP contracts and examples

This reference follows this repository's `src/server.ts`, `src/scene.ts`, `src/http.ts`, and checkpoint/widget implementations. Confirm the running version through its live tools before authoring.

## Tool inputs

`create_view` accepts **exactly one** of:

```json
{"elements":"[]"}
```

```json
{"scene":"{\"elements\":[],\"files\":{},\"appState\":{\"viewBackgroundColor\":\"#ffffff\"}}"}
```

Build the array/object first, then serialize it once. Do not send both fields, comments, trailing commas, or a direct array instead of the required string.

The result contains `checkpointId`, `revision`, and optional `warnings`. Each create call makes a new checkpoint; a restore-plus-edit does not silently overwrite the referenced checkpoint.

## Small generated diagram

Serialize this array into `elements`:

```json
[
  {"type":"cameraUpdate","x":0,"y":0,"width":800,"height":600},
  {"type":"rectangle","id":"client","x":80,"y":200,"width":200,"height":80,"backgroundColor":"#a5d8ff","label":{"text":"Client","fontSize":20}},
  {"type":"rectangle","id":"service","x":460,"y":200,"width":200,"height":80,"backgroundColor":"#b2f2bb","label":{"text":"Service","fontSize":20}},
  {"type":"arrow","id":"request","x":280,"y":240,"width":180,"height":0,"points":[[0,0],[180,0]],"endArrowhead":"arrow","startBinding":{"elementId":"client","fixedPoint":[1,0.5]},"endBinding":{"elementId":"service","fixedPoint":[0,0.5]}}
]
```

## Operations

`restoreCheckpoint` is first and unique. Use only a handle actually returned by the server.

`cameraUpdate` has finite x/y and positive width/height. Prefer a 4:3 camera for this widget, although the validator does not require that ratio.

`delete` accepts comma-separated IDs or an ID array. It applies in order to restored and newly added elements. Unknown targets fail, duplicate/reused element IDs fail, and bound text is removed with its container.

Arrow/line point offsets may be negative. Do not confuse a signed skeleton arrow extent with an invalid negative rectangle width.

## Complete checkpoint state

The internal canonical scene contains `schemaVersion: 1`, `elements`, `files`, `appState`, and optional `viewport`. Files and appState are required for a versioned scene, even when empty. Checkpoints additionally carry `revision`.

Persistent appState includes canvas/export settings and grid configuration. Selection, collaborators, dragging/session state, and arbitrary runtime objects are not persisted.

The app-only save tool requires `id`, a serialized complete scene in `data`, and `expectedRevision`. Missing expectations are rejected. Positive expectations compare-and-swap; an acknowledged legacy revision zero is intentionally migrated by the update handler. Do not invoke these app-only operations as a shortcut for ordinary model-authored edits.

The widget can send text/style edit summaries and bounded PNG context if supported by its host. This updates future model context; it is not proof that every host supports screenshots or triggers a new model turn.

## Limits

| Limit | Current value |
| --- | --- |
| HTTP request, including envelope/escaping | 4 MiB |
| Decoded scene/checkpoint | 5 MiB |
| Final elements | 5,000 |
| Input operations | 10,000 |
| Image files | 100 |
| Decoded bytes per image | 2 MiB |

Stored scenes can be larger than one HTTP request. Incremental edits do not bypass the total scene limit.

## Deployment behavior

Local stdio starts on demand and uses persistent user-local files; it needs no Redis or HTTP listener. Local HTTP is loopback by default. Cloud/Vercel requires durable Redis unless explicit ephemeral memory mode is chosen.

Modern MCP2026-07-28 and legacy2025-11-25 serving coexist. The Apps iframe handshake is separate. Do not infer modern compatibility merely from a sessionless flag or use a legacy transport initialization recipe to test it.
