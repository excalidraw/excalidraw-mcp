import { describe, expect, it } from "vitest";
import { serializeWidgetContext } from "./context-serializer";
import { createWidgetContextState } from "./context-store";

describe("widget context serializer", () => {
  it("returns empty content when there is no context", () => {
    expect(serializeWidgetContext(createWidgetContextState())).toEqual({ content: [] });
  });

  it("serializes selection-only context as a short breadcrumb plus structured selection", () => {
    const state = {
      ...createWidgetContextState(),
      selection: {
        elements: [{ id: "r1", type: "rectangle", label: "Database" }],
      },
    };

    expect(serializeWidgetContext(state)).toEqual({
      content: [{
        type: "text",
        text: 'Selected 1 element.\n\nElements:\n- rectangle "Database"',
      }],
      structuredContent: {
        selection: {
          elements: [{ id: "r1", type: "rectangle", label: "Database" }],
        },
      },
    });
  });

  it("serializes merged selection, comments, edits, and checkpoint in one stable payload", () => {
    const state = {
      ...createWidgetContextState(),
      checkpointId: "cp-999",
      selection: {
        elements: [{ id: "r1", type: "rectangle" }],
      },
      latestEditSummary: "User edited diagram. Moved/resized: r1 → (20,30) 100x80",
      edits: [{ summary: "User edited diagram. Moved/resized: r1 → (20,30) 100x80", ts: 10 }],
      comments: [{ text: "make this clearer", selectionElements: [{ id: "r1", type: "rectangle" }], ts: 20 }],
      lastAction: { type: "comment" as const, ts: 20 },
    };

    expect(serializeWidgetContext(state)).toEqual({
      content: [{
        type: "text",
        text: 'Selected 1 element.\n\nElements:\n- rectangle (r1)\n\nRecent comments:\n- "make this clearer"\n\nRecent edits:\n- User edited diagram. Moved/resized: r1 → (20,30) 100x80',
      }],
      structuredContent: {
        checkpointId: "cp-999",
        selection: {
          elements: [{ id: "r1", type: "rectangle" }],
        },
        edits: [{ summary: "User edited diagram. Moved/resized: r1 → (20,30) 100x80", ts: 10 }],
        comments: [{ text: "make this clearer", selectionElements: [{ id: "r1", type: "rectangle" }], ts: 20 }],
        lastAction: { type: "comment", ts: 20 },
      },
    });
  });
});
