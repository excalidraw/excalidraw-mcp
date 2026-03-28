export interface WidgetContextElement {
  id: string;
  type: string;
  label?: string;
}

export interface WidgetContextSelection {
  elements: WidgetContextElement[];
}

export interface WidgetContextEditEntry {
  summary: string;
  ts: number;
}

export interface WidgetContextCommentEntry {
  text: string;
  selectionElements: WidgetContextElement[];
  ts: number;
}

export interface WidgetContextLastAction {
  type: "selection" | "edit" | "comment" | "checkpoint" | "reset" | "clear-selection";
  ts: number;
}

export interface WidgetContextState {
  checkpointId: string | null;
  selection: WidgetContextSelection | null;
  latestEditSummary: string | null;
  edits: WidgetContextEditEntry[];
  comments: WidgetContextCommentEntry[];
  lastAction: WidgetContextLastAction | null;
}

const MAX_EDIT_HISTORY = 3;
const MAX_COMMENT_HISTORY = 3;

export function createWidgetContextState(): WidgetContextState {
  return {
    checkpointId: null,
    selection: null,
    latestEditSummary: null,
    edits: [],
    comments: [],
    lastAction: null,
  };
}

function now() {
  return Date.now();
}

function stamp(type: WidgetContextLastAction["type"]): WidgetContextLastAction {
  return { type, ts: now() };
}

function pushBounded<T>(entries: T[], entry: T, max: number) {
  return [...entries, entry].slice(-max);
}

export function setSelection(
  state: WidgetContextState,
  details: WidgetContextElement[],
): WidgetContextState {
  if (details.length === 0) {
    return clearSelection(state);
  }

  return {
    ...state,
    selection: { elements: details },
    lastAction: stamp("selection"),
  };
}

export function clearSelection(state: WidgetContextState): WidgetContextState {
  if (!state.selection) {
    return state;
  }

  return {
    ...state,
    selection: null,
    lastAction: stamp("clear-selection"),
  };
}

export function setCheckpoint(
  state: WidgetContextState,
  checkpointId: string | null,
): WidgetContextState {
  if (state.checkpointId === checkpointId) {
    return state;
  }

  return {
    ...state,
    checkpointId,
    lastAction: stamp("checkpoint"),
  };
}

export function recordEdit(
  state: WidgetContextState,
  summary: string | null,
): WidgetContextState {
  if (!summary) {
    return {
      ...state,
      latestEditSummary: null,
      edits: [],
    };
  }

  if (state.edits[state.edits.length - 1]?.summary === summary) {
    return state;
  }

  const entry: WidgetContextEditEntry = { summary, ts: now() };
  return {
    ...state,
    latestEditSummary: summary,
    edits: pushBounded(state.edits, entry, MAX_EDIT_HISTORY),
    lastAction: stamp("edit"),
  };
}

export function recordComment(
  state: WidgetContextState,
  text: string,
  selectionSnapshot: WidgetContextElement[],
): WidgetContextState {
  const trimmed = text.trim();
  if (!trimmed) {
    return state;
  }

  const entry: WidgetContextCommentEntry = {
    text: trimmed,
    selectionElements: selectionSnapshot,
    ts: now(),
  };

  return {
    ...state,
    comments: pushBounded(state.comments, entry, MAX_COMMENT_HISTORY),
    lastAction: stamp("comment"),
  };
}

export function resetForNewToolResult(state: WidgetContextState): WidgetContextState {
  return {
    ...state,
    selection: null,
    latestEditSummary: null,
    edits: [],
    comments: [],
    lastAction: stamp("reset"),
  };
}
