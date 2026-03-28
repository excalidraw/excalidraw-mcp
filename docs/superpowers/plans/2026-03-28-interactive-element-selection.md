# Interactive Element Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user selects elements in the fullscreen Excalidraw editor, Claude automatically receives their identity (type + label + id) as context on the next message.

**Architecture:** `onSelectionChange` in `edit-context.ts` handles debouncing and `updateModelContext` calls. `ExcalidrawAppCore` in `mcp-app.tsx` wires Excalidraw's `onChange` callback to call it, and renders a selection badge in the toolbar.

**Tech Stack:** TypeScript, React 19, Excalidraw `@excalidraw/excalidraw`, MCP ext-apps SDK, Vitest

---

### Task 1: Add vitest and write `onSelectionChange` with TDD

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Modify: `src/edit-context.ts`
- Create: `src/edit-context.test.ts`

- [ ] **Step 1: Install vitest**

```bash
pnpm add -D vitest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 3: Add test script to `package.json`**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run"
```

- [ ] **Step 4: Write failing tests for `onSelectionChange`**

Create `src/edit-context.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { onSelectionChange } from "./edit-context.js";

function makeApp() {
  return { updateModelContext: vi.fn().mockResolvedValue(undefined) } as any;
}

describe("onSelectionChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends identity summary for a single selected rectangle with label", async () => {
    const app = makeApp();
    const elements = [
      { id: "r1", type: "rectangle", label: { text: "Database" } },
      { id: "e1", type: "ellipse", label: { text: "Cache" } },
    ];
    onSelectionChange(app, { r1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: "text", text: "Selected: rectangle 'Database' (r1)" }],
    });
  });

  it("sends identity summary for multiple selected elements", async () => {
    const app = makeApp();
    const elements = [
      { id: "r1", type: "rectangle", label: { text: "Database" } },
      { id: "a1", type: "arrow", text: "writes to" },
    ];
    onSelectionChange(app, { r1: true, a1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: "text", text: "Selected: rectangle 'Database' (r1), arrow 'writes to' (a1)" }],
    });
  });

  it("omits label when element has no text", async () => {
    const app = makeApp();
    const elements = [{ id: "r1", type: "rectangle" }];
    onSelectionChange(app, { r1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: "text", text: "Selected: rectangle (r1)" }],
    });
  });

  it("clears context when no elements are selected", async () => {
    const app = makeApp();
    const elements = [{ id: "r1", type: "rectangle", label: { text: "DB" } }];
    onSelectionChange(app, {}, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({ content: [] });
  });

  it("debounces — only fires once for rapid calls", async () => {
    const app = makeApp();
    const elements = [{ id: "r1", type: "rectangle", label: { text: "DB" } }];
    onSelectionChange(app, { r1: true }, elements);
    onSelectionChange(app, { r1: true }, elements);
    onSelectionChange(app, { r1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 5: Run tests — expect FAIL (function not yet exported)**

```bash
pnpm test
```

Expected: FAIL — `onSelectionChange is not a function` or import error

- [ ] **Step 6: Implement `onSelectionChange` in `src/edit-context.ts`**

Add after the existing imports and module-level variables (after the `timer` variable block):

```typescript
const SELECTION_DEBOUNCE_MS = 300;
let selectionTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Call from Excalidraw's onChange when selectedElementIds changes.
 * Updates model context with identity of selected elements (debounced).
 * Clears context when selection is empty.
 */
export function onSelectionChange(
  app: App,
  selectedIds: Record<string, boolean>,
  allElements: readonly any[]
) {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selected = allElements.filter((el: any) => selectedIds[el.id]);
    if (selected.length === 0) {
      app.updateModelContext({ content: [] }).catch(() => {});
      return;
    }
    const parts = selected.map((el: any) => {
      const label = el.label?.text ?? el.text ?? "";
      return `${el.type}${label ? ` '${label}'` : ""} (${el.id})`;
    });
    app.updateModelContext({
      content: [{ type: "text", text: `Selected: ${parts.join(", ")}` }],
    }).catch(() => {});
  }, SELECTION_DEBOUNCE_MS);
}
```

- [ ] **Step 7: Run tests — expect PASS**

```bash
pnpm test
```

Expected: all 5 tests pass

- [ ] **Step 8: Commit**

```bash
git add src/edit-context.ts src/edit-context.test.ts vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat: add onSelectionChange to edit-context with tests"
```

---

### Task 2: Wire selection into the Excalidraw onChange callback

**Files:**
- Modify: `src/mcp-app.tsx` (around line 901 — the `onChange` prop on `<Excalidraw>`)

- [ ] **Step 1: Import `onSelectionChange`**

In `src/mcp-app.tsx`, find the existing import of `onEditorChange`:

```typescript
import { captureInitialElements, onEditorChange, setStorageKey, loadPersistedElements, getLatestEditedElements, setCheckpointId } from "./edit-context";
```

Add `onSelectionChange` to the import:

```typescript
import { captureInitialElements, onEditorChange, onSelectionChange, setStorageKey, loadPersistedElements, getLatestEditedElements, setCheckpointId } from "./edit-context";
```

- [ ] **Step 2: Add `selectedCount` state to `ExcalidrawAppCore`**

Find the existing state declarations near line 656:

```typescript
const [editorSettled, setEditorSettled] = useState(false);
```

Add after it:

```typescript
const [selectedCount, setSelectedCount] = useState(0);
```

- [ ] **Step 3: Update the `onChange` callback on `<Excalidraw>` to include selection**

Find (around line 901):

```typescript
onChange={(els) => onEditorChange(app, els)}
```

Replace with:

```typescript
onChange={(els, appState) => {
  onEditorChange(app, els);
  const ids = (appState as any).selectedElementIds ?? {};
  const count = Object.values(ids).filter(Boolean).length;
  setSelectedCount(count);
  onSelectionChange(app, ids, els);
}}
```

- [ ] **Step 4: Build and verify no TypeScript errors**

```bash
npm run build
```

Expected: build succeeds with no errors

- [ ] **Step 5: Commit**

```bash
git add src/mcp-app.tsx
git commit -m "feat: wire Excalidraw selection to onSelectionChange"
```

---

### Task 3: Add selection badge to fullscreen toolbar

**Files:**
- Modify: `src/mcp-app.tsx` (renderTopRightUI and inline Edit button)

- [ ] **Step 1: Add selection badge to `renderTopRightUI`**

Find the existing `renderTopRightUI` prop (around line 902):

```typescript
renderTopRightUI={isNarrow ? undefined : () => (
  <ShareButton
    onConfirm={async () => {
```

Replace with:

```typescript
renderTopRightUI={isNarrow ? undefined : () => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    {selectedCount > 0 && (
      <span
        className="app-button"
        style={{ fontSize: "0.75rem", fontWeight: 400, cursor: "default", opacity: 0.7 }}
        title="Claude will see the selected elements when you send a message"
      >
        {selectedCount === 1 ? "1 element selected" : `${selectedCount} elements selected`}
      </span>
    )}
    <ShareButton
      onConfirm={async () => {
```

Close the wrapper `</div>` after the closing `/>` of `<ShareButton ... />`:

```typescript
    />
  </div>
)}
```

- [ ] **Step 2: Update inline Edit button tooltip**

Find (around line 882):

```typescript
title="Enter fullscreen"
```

Replace with:

```typescript
title="Enter fullscreen to edit and select elements"
```

- [ ] **Step 3: Build and verify no TypeScript errors**

```bash
npm run build
```

Expected: build succeeds

- [ ] **Step 4: Smoke test in dev mode**

```bash
npm run dev:ui
```

Open `http://localhost:5173/index-dev.html`. Enter fullscreen, click an element — verify the badge appears in the top-right corner. Click away to deselect — verify the badge disappears. Hover the inline Edit button — verify updated tooltip.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-app.tsx
git commit -m "feat: show selection badge in fullscreen toolbar"
```

---

## Known trade-off

`onSelectionChange` and `onEditorChange` both call `updateModelContext`, which replaces context each time (last write wins). In the typical flow they don't conflict: selection fires at 300ms, edits at 2000ms. If the user edits then immediately selects, the selection context (faster) will be overwritten by the edit diff (slower). This is acceptable for V1 — the edit diff is the more actionable signal for Claude.
