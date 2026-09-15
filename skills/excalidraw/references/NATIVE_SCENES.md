# Native scenes and visual guidance

## Portable file structure

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "local",
  "elements": [],
  "appState": {"viewBackgroundColor": "#ffffff"},
  "files": {}
}
```

Use native elements in a portable file. Skeleton `label`, `start`, and `end` convenience fields belong to the conversion API/MCP authoring route, not to an already-exported native scene. `cameraUpdate`, `restoreCheckpoint`, and `delete` are this MCP server's operations, not Excalidraw element types.

Prefer the widget's local download or the version-compatible `serializeAsJSON(elements, appState, files, "local")` utility when a browser runtime is available. The `"database"` target strips image files; it is not a complete local export.

## Text, fonts, and layout

Preserve explicit native font choices. Do not assume Virgil/font1 is the only or current default font: the MCP widget defaults generated text to Excalifont, while the package supports other families. Use the running server's reference or the installed package's `FONT_FAMILY` constant rather than an outdated hard-coded mapping.

For native text, retain valid width/height and measured text properties. Use font-ready browser conversion/restoration for accurate metrics. A universal `fontSize * 2.5 * lineCount` rule is not an Excalidraw contract and can distort layout. If measurement is unavailable, state that dimensions are estimated and inspect the result when possible.

Use readable text, consistent spacing, and a small coordinated palette. Dark text suits light fills; dark backgrounds require light, high-contrast text. Do not force black text on a dark diagram.

Use transparent or low-opacity background zones where they keep inner content readable. Native containers may have fills; transparency is a design choice, not a file-format requirement.

## Bound labels

In native data, a container's `boundElements` references its text element; the text element's `containerId` references the container. Preserve both sides and valid positions/dimensions. A `containerId` alone is not a universal automatic-layout instruction for raw JSON.

For newly generated MCP diagrams, a skeleton `label` is usually simpler and less error-prone.

## Images

Each live image's `fileId` must reference a matching `files` entry, including its ID, MIME type, base64 data URL, and creation timestamp. Preserve the actual image bytes; references alone cannot recreate an image.

Do not claim an external share link preserves images. This server blocks that route because the public sharing site's image storage is separate. Use a complete local file and an approved editor instead.

## Browser handling

Use only an editor permitted by local policy. Prefer supported native Open/Save file chooser interactions, and inspect the current interface rather than assuming old selectors or keyboard shortcuts.

Do not work around authentication, sandbox permissions, or network CSP. A screenshot can include UI chrome and is not the same as a clean PNG/SVG export. Label it accurately, and keep the editable source beside rendered derivatives.
