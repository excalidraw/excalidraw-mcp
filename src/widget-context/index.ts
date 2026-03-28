import type { App } from "@modelcontextprotocol/ext-apps";
import {
  clearSelection,
  createWidgetContextState,
  recordComment,
  recordEdit,
  resetForNewToolResult,
  setCheckpoint,
  setSelection,
  type WidgetContextElement,
  type WidgetContextState,
} from "./context-store";
import { serializeWidgetContext } from "./context-serializer";

export type WidgetContextPayload = Parameters<App["updateModelContext"]>[0];

export interface WidgetContextController {
  getState(): WidgetContextState;
  setSelection(details: WidgetContextElement[]): WidgetContextState;
  clearSelection(): WidgetContextState;
  recordEdit(summary: string | null): WidgetContextState;
  recordComment(text: string, selectionSnapshot: WidgetContextElement[]): WidgetContextState;
  setCheckpoint(id: string | null): WidgetContextState;
  resetForNewToolResult(): WidgetContextState;
  buildPayload(): WidgetContextPayload;
}

export function createWidgetContextController(
  initialState: WidgetContextState = createWidgetContextState(),
): WidgetContextController {
  let state = initialState;

  return {
    getState: () => state,
    setSelection(details) {
      state = setSelection(state, details);
      return state;
    },
    clearSelection() {
      state = clearSelection(state);
      return state;
    },
    recordEdit(summary) {
      state = recordEdit(state, summary);
      return state;
    },
    recordComment(text, selectionSnapshot) {
      state = recordComment(state, text, selectionSnapshot);
      return state;
    },
    setCheckpoint(id) {
      state = setCheckpoint(state, id);
      return state;
    },
    resetForNewToolResult() {
      state = resetForNewToolResult(state);
      return state;
    },
    buildPayload() {
      return serializeWidgetContext(state);
    },
  };
}

export function flushModelContext(app: App, context: WidgetContextController) {
  return app.updateModelContext(context.buildPayload()).catch(() => {});
}

export type {
  WidgetContextCommentEntry,
  WidgetContextEditEntry,
  WidgetContextElement,
  WidgetContextLastAction,
  WidgetContextSelection,
  WidgetContextState,
} from "./context-store";

export { createWidgetContextState } from "./context-store";
export { serializeWidgetContext } from "./context-serializer";
