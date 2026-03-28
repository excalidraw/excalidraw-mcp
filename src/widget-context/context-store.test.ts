import { describe, expect, it, vi } from "vitest";
import {
  clearSelection,
  createWidgetContextState,
  recordComment,
  recordEdit,
  resetForNewToolResult,
  setCheckpoint,
  setSelection,
} from "./context-store";

describe("widget context store", () => {
  it("replaces selection and clears it cleanly", () => {
    let state = createWidgetContextState();
    state = setSelection(state, [{ id: "r1", type: "rectangle", label: "DB" }]);
    expect(state.selection).toEqual({
      elements: [{ id: "r1", type: "rectangle", label: "DB" }],
    });

    state = setSelection(state, [{ id: "a1", type: "arrow" }]);
    expect(state.selection).toEqual({
      elements: [{ id: "a1", type: "arrow" }],
    });

    state = clearSelection(state);
    expect(state.selection).toBeNull();
    expect(state.lastAction?.type).toBe("clear-selection");
  });

  it("accumulates bounded edit history and dedupes consecutive summaries", () => {
    vi.useFakeTimers();
    try {
      let state = createWidgetContextState();
      state = recordEdit(state, "move-1");
      vi.advanceTimersByTime(1);
      state = recordEdit(state, "move-1");
      vi.advanceTimersByTime(1);
      state = recordEdit(state, "move-2");
      vi.advanceTimersByTime(1);
      state = recordEdit(state, "move-3");
      vi.advanceTimersByTime(1);
      state = recordEdit(state, "move-4");

      expect(state.latestEditSummary).toBe("move-4");
      expect(state.edits.map((entry) => entry.summary)).toEqual(["move-2", "move-3", "move-4"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a bounded recent comment history with selection snapshots", () => {
    vi.useFakeTimers();
    try {
      let state = createWidgetContextState();
      state = recordComment(state, "first", [{ id: "r1", type: "rectangle" }]);
      vi.advanceTimersByTime(1);
      state = recordComment(state, "second", [{ id: "r2", type: "ellipse" }]);
      vi.advanceTimersByTime(1);
      state = recordComment(state, "third", [{ id: "r3", type: "diamond" }]);
      vi.advanceTimersByTime(1);
      state = recordComment(state, "fourth", [{ id: "r4", type: "arrow" }]);

      expect(state.comments).toHaveLength(3);
      expect(state.comments.map((entry) => entry.text)).toEqual(["second", "third", "fourth"]);
      expect(state.comments[2]?.selectionElements).toEqual([{ id: "r4", type: "arrow" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets edit and comment history for a new tool result while preserving checkpoint", () => {
    let state = createWidgetContextState();
    state = setCheckpoint(state, "cp-123");
    state = setSelection(state, [{ id: "r1", type: "rectangle" }]);
    state = recordEdit(state, "move");
    state = recordComment(state, "please align this", [{ id: "r1", type: "rectangle" }]);

    state = resetForNewToolResult(state);

    expect(state.checkpointId).toBe("cp-123");
    expect(state.selection).toBeNull();
    expect(state.latestEditSummary).toBeNull();
    expect(state.edits).toEqual([]);
    expect(state.comments).toEqual([]);
    expect(state.lastAction?.type).toBe("reset");
  });
});
