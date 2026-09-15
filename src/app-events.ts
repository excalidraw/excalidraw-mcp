import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export type WidgetEvent =
  | { type: "input" | "partial"; value: unknown }
  | { type: "result"; value: Parameters<NonNullable<App["ontoolresult"]>>[0] }
  | { type: "context"; value: Partial<McpUiHostContext> }
  | { type: "cancelled"; value: unknown }
  | { type: "error"; value: unknown };

/** Exists before useApp connects; early notifications survive the child's first effect. */
export function createAppEventBuffer() {
  let listener: ((event: WidgetEvent) => void) | undefined;
  let queue: WidgetEvent[] = [];
  let teardown: (() => Promise<void>) | undefined;
  const publish = (event: WidgetEvent) => {
    if (event.type === "context") {
      const previous = queue.find((item): item is Extract<WidgetEvent, { type: "context" }> => item.type === "context");
      event = { ...event, value: { ...previous?.value, ...event.value } };
    }
    queue = queue.filter((item) => item.type !== event.type && !(event.type === "input" && item.type === "partial"));
    queue.push(event);
    listener?.(event);
  };
  return {
    register(app: App) {
      app.ontoolinput = (value) => publish({ type: "input", value });
      app.ontoolinputpartial = (value) => publish({ type: "partial", value });
      app.ontoolresult = (value) => publish({ type: "result", value });
      app.onhostcontextchanged = (value) => publish({ type: "context", value });
      app.ontoolcancelled = (value) => publish({ type: "cancelled", value });
      app.onerror = (value) => publish({ type: "error", value });
      app.onteardown = async () => {
        await teardown?.();
        return {};
      };
    },
    subscribe(next: (event: WidgetEvent) => void, flush: () => Promise<void>) {
      listener = next;
      teardown = flush;
      // Retain the latest notifications for Strict Mode's effect replay or a remount.
      for (const event of [...queue]) next(event);
      return () => { if (listener === next) listener = undefined; };
    },
    publish,
  };
}

export type AppEventBuffer = ReturnType<typeof createAppEventBuffer>;
