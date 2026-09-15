import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { createAppEventBuffer, type AppEventBuffer } from "./app-events.js";
import { hasLiveImages, IMAGE_SHARING_MESSAGE } from "./sharing.js";
import { findRestoreCheckpoint, parseElementsInput, parseSceneData, reduceSceneOperations, type Checkpoint, type SceneData } from "./scene.js";

export interface MockAppControls {
  app: App;
  events: AppEventBuffer;
  checkpoints: Map<string, Checkpoint>;
  logs: string[];
  sendToolInput(elements: unknown[]): void;
  sendSceneInput(scene: SceneData): void;
  sendInvalidInput(json: string): void;
  sendToolInputPartial(elements: unknown[]): void;
  sendToolResult(checkpointId?: string): void;
  sendCancelled(): void;
  setHostContext(context: Partial<McpUiHostContext>): void;
  failNextSave(outcome: "transient" | "error" | "conflict"): void;
  delaySaves(milliseconds: number): void;
  streamElements(elements: unknown[], intervalMs?: number): void;
}

export function createMockApp(): MockAppControls {
  const events = createAppEventBuffer();
  const checkpoints = new Map<string, Checkpoint>();
  const logs: string[] = [];
  let pending: SceneData | undefined;
  let nextFailure: "transient" | "error" | "conflict" | undefined;
  let delay = 0, sequence = 0, stream = 0;
  let hostContext: McpUiHostContext = {
    displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], theme: "light",
    containerDimensions: { height: typeof window === "undefined" ? 800 : window.innerHeight },
  };
  const app = {
    async sendLog({ logger, data }: { logger?: string; data: unknown }) { logs.push(`[${logger}] ${String(data)}`); },
    async requestDisplayMode({ mode }: { mode: McpUiHostContext["displayMode"] }) {
      const accepted = hostContext.availableDisplayModes?.includes(mode!) ? mode : hostContext.displayMode;
      hostContext = { ...hostContext, displayMode: accepted };
      events.publish({ type: "context", value: hostContext });
      return { mode: accepted };
    },
    async callServerTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
      if (name === "read_checkpoint") {
        const checkpoint = checkpoints.get(String(args.id));
        return checkpoint ? { structuredContent: structuredClone(checkpoint), content: [{ type: "text", text: JSON.stringify(checkpoint) }] }
          : { isError: true, content: [{ type: "text", text: "Checkpoint not found." }] };
      }
      if (name === "save_checkpoint") {
        if (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0) return {
          isError: true, _meta: { code: "revision_required" },
          content: [{ type: "text", text: "An acknowledged revision is required. Reload the server copy or download the diagram locally." }],
        };
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const failure = nextFailure; nextFailure = undefined;
        if (failure === "transient") throw new TypeError("Mock connection failure.");
        if (failure === "error") return { isError: true, _meta: { code: "storage_error" }, content: [{ type: "text", text: "Mock storage failure. Retry save or download your edits." }] };
        const id = String(args.id), current = checkpoints.get(id);
        if (failure === "conflict" && current) current.revision++;
        if (!current || args.expectedRevision !== current.revision) return {
          isError: true, _meta: { code: "revision_conflict", currentRevision: current?.revision ?? null },
          content: [{ type: "text", text: "Revision conflict: the server copy changed. Download your edits and reload the server copy." }],
        };
        const data: unknown = JSON.parse(String(args.data));
        if (!data || typeof data !== "object" || !("schemaVersion" in data) || data.schemaVersion !== 1) return {
          isError: true, _meta: { code: "schema_required" },
          content: [{ type: "text", text: "A versioned scene is required. Reload with the updated widget before saving." }],
        };
        const updated: Checkpoint = { ...parseSceneData(data), revision: current.revision + 1 };
        if (current.revision === 0 && current.recovery?.unavailableImages.some((image) => !updated.elements.some((element) => element.type === "image" && element.id === image.id))) return {
          isError: true,
          content: [{ type: "text", text: "Restore the unavailable legacy images before updating this checkpoint, or download the recovered scene locally." }],
        };
        checkpoints.set(id, updated);
        return { structuredContent: { checkpointId: id, revision: updated.revision }, content: [] };
      }
      if (name === "export_to_excalidraw") {
        const scene = parseSceneData(JSON.parse(String(args.json)));
        return hasLiveImages(scene.elements)
          ? { isError: true, content: [{ type: "text", text: IMAGE_SHARING_MESSAGE }] }
          : { content: [{ type: "text", text: "https://excalidraw.com/#mock-dev" }] };
      }
      return { isError: true, content: [{ type: "text", text: `Unknown mock tool: ${name}` }] };
    },
    getHostContext: () => hostContext,
    getHostCapabilities: () => ({ serverTools: {}, updateModelContext: { text: {}, image: {} } }),
    async openLink({ url }: { url: string }) { logs.push(`Open link: ${url}`); return {}; },
    async updateModelContext(value: unknown) { logs.push(`Model context: ${JSON.stringify(value)}`); return {}; },
  } as unknown as App;
  events.register(app);

  const sendToolInput = (elements: unknown[]) => {
    const operations = parseElementsInput(JSON.stringify(elements));
    const restoreId = findRestoreCheckpoint(operations);
    pending = reduceSceneOperations(operations, restoreId ? checkpoints.get(restoreId) : undefined);
    events.publish({ type: "input", value: { arguments: { elements: JSON.stringify(elements) } } });
  };
  const sendToolResult = (checkpointId = `dev-checkpoint-${++sequence}`) => {
    if (pending) checkpoints.set(checkpointId, { ...structuredClone(pending), revision: 1 });
    const revision = checkpoints.get(checkpointId)?.revision ?? 1;
    events.publish({ type: "result", value: { structuredContent: { checkpointId, revision }, content: [] } });
  };
  return {
    app, events, checkpoints, logs, sendToolInput, sendToolResult,
    sendSceneInput(scene) {
      pending = parseSceneData(scene);
      events.publish({ type: "input", value: { arguments: { scene: JSON.stringify(scene) } } });
    },
    sendInvalidInput(json) { events.publish({ type: "input", value: { arguments: { elements: json } } }); },
    sendToolInputPartial(elements) { events.publish({ type: "partial", value: { arguments: { elements: JSON.stringify(elements) } } }); },
    sendCancelled() { stream++; events.publish({ type: "cancelled", value: { reason: "Cancelled in the dev harness." } }); },
    setHostContext(context) { hostContext = { ...hostContext, ...context }; events.publish({ type: "context", value: context }); },
    failNextSave(outcome) { nextFailure = outcome; },
    delaySaves(milliseconds) { delay = milliseconds; },
    streamElements(elements, intervalMs = 120) {
      const epoch = ++stream;
      let index = 0;
      const tick = () => {
        if (epoch !== stream) return;
        if (index < elements.length) {
          events.publish({ type: "partial", value: { arguments: { elements: JSON.stringify(elements.slice(0, ++index)) } } });
          setTimeout(tick, intervalMs);
        } else { sendToolInput(elements); sendToolResult(); }
      };
      tick();
    },
  };
}
