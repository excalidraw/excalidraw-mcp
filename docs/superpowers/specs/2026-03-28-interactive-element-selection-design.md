# Interactive Element Selection Design

**Date:** 2026-03-28
**Status:** Approved

## Summary

Enable users to select elements in the Excalidraw fullscreen editor and have Claude automatically receive the selected elements' identity as context when the user sends a message.

## Scope

- Fullscreen mode only (no SVG hit-testing in inline mode)
- Inline mode gets a tooltip nudge on the Edit button pointing users to fullscreen
- No server-side changes

## Behavior

1. User enters fullscreen and selects one or more elements
2. Widget detects the selection via Excalidraw's `onChange` callback (`appState.selectedElementIds`)
3. Widget calls `app.updateModelContext()` with the identity summary (debounced 300ms)
4. A badge in the toolbar shows "N element(s) selected — Claude will see this"
5. User types a message and sends — Claude receives the message plus the current selection context
6. User deselects — context clears — next message has no selection context

`updateModelContext()` is idempotent and replaces the previous value, so Claude always sees the current selection at message-send time.

### Multi-select

Shift-click or drag-select: all selected elements are listed.
Example: `"Selected: rectangle 'Database' (r1), ellipse 'Cache' (e1)"`

### Sequential selection

Selecting element 1 then element 2 replaces the context each time. Claude only sees the state at message-send time, not selection history.

## Element context format

Identity only — type, label/text, and ID:

```
Selected: rectangle 'Database' (r1)
Selected: rectangle 'Database' (r1), arrow 'writes to' (a2)
```

No position, size, color, or other properties.

## UI

- **Badge** in `renderTopRightUI` area: `"N element(s) selected"`, styled as existing `app-button` (subtle, informational, not a button)
- Conditionally rendered — disappears when selection is empty
- **Inline mode** Edit button: `title="Enter fullscreen to edit and select elements"`

## Implementation

### `src/edit-context.ts`

Add `onSelectionChange(app, selectedIds, allElements)`:
- Filter `allElements` to those whose IDs are in `selectedIds`
- Build identity string per element: `type + label/text + id`
- Call `app.updateModelContext({ content: [{ type: "text", text: summary }] })` or clear if empty
- 300ms debounce (separate timer from edit debounce)

### `src/mcp-app.tsx`

1. In `onChange` handler on `<Excalidraw>`, extract `appState.selectedElementIds` and call `onSelectionChange(app, selectedIds, elements)`
2. Set `selectedCount` state in the same handler for the badge
3. Add badge component in `renderTopRightUI` (conditionally rendered when `selectedCount > 0`)
4. Update inline Edit button tooltip

## Files changed

| File | Change |
|------|--------|
| `src/edit-context.ts` | Add `onSelectionChange` function + debounce timer |
| `src/mcp-app.tsx` | Wire `onChange` → `onSelectionChange`, add badge, update tooltip |
