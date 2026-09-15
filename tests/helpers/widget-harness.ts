import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import ts from "typescript";
import * as editContext from "../../src/edit-context.js";
import * as appEvents from "../../src/app-events.js";
import * as sceneModule from "../../src/scene.js";
import * as renderQueue from "../../src/render-queue.js";
import * as sharing from "../../src/sharing.js";
import * as metadata from "../../src/metadata.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { SceneData } from "../../src/scene.js";
import type { SaveResult } from "../../src/edit-context.js";

type Node = { type: string | Function; props: Record<string, any> };
type Hook = { value?: any; dependencies?: unknown[]; cleanup?: () => void; effect?: () => (() => void) | void };
export type ToolCall = { name: string; arguments: { id: string; data: string; expectedRevision: number } };
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
export const acknowledgement = (checkpointId: string, revision = 1): SaveResult =>
  ({ content: [], structuredContent: { checkpointId, revision } });

const compiled = ts.transpileModule(readFileSync(new URL("../../src/mcp-app.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Executes the real component and effects, retaining hooks across rerenders.
 * Only browser rendering/bridge dependencies are substituted; scene/controller/event logic is real.
 */
export function widgetHarness(options: {
  checkpoints: Record<string, SceneData>;
  storageDenied?: boolean;
  read?: (id: string) => Promise<SaveResult>;
  save?: (call: ToolCall) => Promise<SaveResult>;
  initialEvents?: appEvents.WidgetEvent[];
  loadFonts?: () => Promise<void>;
}) {
  const hooks: Hook[] = [];
  let cursor = 0, dirty = true;
  let effects: (() => void)[] = [];
  let tree: Node;
  const calls: ToolCall[] = [];
  const contexts: { content: { type: string; text?: string }[] }[] = [];
  const downloads: Blob[] = [];
  const blobs = new Map<string, Blob>();
  const values = new Map<string, string>();
  const noop = () => {};
  const same = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next: any) => {
        const value = typeof next === "function" ? next(hooks[index].value) : next;
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; }
      }];
    },
    useRef(initial: any) {
      const index = cursor++;
      hooks[index] ??= { value: { current: initial } };
      return hooks[index].value;
    },
    useId() { return react.useRef(`fixture-${cursor}`).current; },
    useCallback(callback: Function, dependencies: unknown[]) {
      const index = cursor++;
      if (!same(hooks[index]?.dependencies, dependencies)) hooks[index] = { value: callback, dependencies };
      return hooks[index].value;
    },
    useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
      const index = cursor++;
      if (same(hooks[index]?.dependencies, dependencies)) return;
      effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { dependencies, effect, cleanup: effect() ?? undefined };
      });
    },
  };
  const jsx = (type: Node["type"], props: Node["props"]) => ({ type, props });
  function Excalidraw() {}
  const MainMenu = Object.assign(function MainMenu() {}, { Item: noop, Separator: noop, DefaultItems: { LoadScene: noop } });
  const serialize = (elements: unknown, appState: unknown, files: unknown) => JSON.stringify({ elements, appState, files });
  const drawing = {
    Excalidraw, MainMenu, serializeAsJSON: serialize,
    exportToBlob: async () => { throw new Error("Unexpected rasterization in text-only lifecycle fixture"); },
  };
  const style = { setProperty: noop, removeProperty: noop };
  const document = {
    addEventListener: noop, removeEventListener: noop, querySelector: () => null,
    documentElement: { style }, body: { style: {} },
    createElement: (tag: string) => {
      assert.equal(tag, "a");
      const link = { href: "", download: "", click: () => { downloads.push(blobs.get(link.href)!); } };
      return link;
    },
  };
  const window = {
    innerWidth: 1000, innerHeight: 750, addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    get localStorage() {
      if (options.storageDenied) throw new Error("Storage denied");
      return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    },
  };
  const app = {
    getHostContext: () => ({ displayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] }),
    getHostCapabilities: () => ({ updateModelContext: { text: true } }),
    callServerTool: async (call: ToolCall) => {
      calls.push(call);
      if (call.name === "read_checkpoint") {
        if (options.read) return options.read(call.arguments.id);
        assert.ok(options.checkpoints[call.arguments.id], "Requested a known fixture checkpoint");
        return { content: [], structuredContent: { ...options.checkpoints[call.arguments.id], revision: 1 } };
      }
      assert.equal(call.name, "save_checkpoint");
      return options.save?.(call) ?? acknowledgement(call.arguments.id, call.arguments.expectedRevision + 1);
    },
    updateModelContext: async (context: typeof contexts[number]) => { contexts.push(context); },
    sendLog: async () => {},
    requestDisplayMode: async ({ mode }: { mode: string }) => ({ mode }),
  } as unknown as App;
  const events = appEvents.createAppEventBuffer();
  events.register(app);
  for (const event of options.initialEvents ?? []) events.publish(event);
  const modules: Record<string, unknown> = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "@modelcontextprotocol/ext-apps/react": {}, "@excalidraw/excalidraw": drawing, morphdom: noop,
    "./edit-context.js": editContext, "./app-events.js": appEvents, "./scene.js": sceneModule,
    "./render-queue.js": renderQueue, "./sharing.js": sharing, "./metadata.js": metadata,
    "./pencil-audio.js": { stopPencilAudio: noop }, "./global.css": {},
    "./widget-scene.js": {
      loadSceneFonts: options.loadFonts ?? (async () => {}),
      toNativeScene: (value: SceneData) => sceneModule.parseSceneData(value),
      nativeElements: (value: SceneData) => value.elements,
      nativeAppState: (value: SceneData) => value.appState,
      nativeFiles: (value: SceneData) => value.files,
      serializeScene: (value: SceneData) => JSON.stringify(value),
    },
  };
  const module = { exports: {} as { ExcalidrawAppCore: (props: { app: App; events: appEvents.AppEventBuffer }) => Node } };
  const globals = {
    exports: module.exports, module, require: (id: string) => {
      assert.ok(id in modules, `Explicit fixture dependency: ${id}`);
      return modules[id];
    },
    window, document, Blob, URL: {
      createObjectURL: (blob: Blob) => { const id = `blob:${blobs.size}`; blobs.set(id, blob); return id; },
      revokeObjectURL: (id: string) => blobs.delete(id),
    },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    requestAnimationFrame: noop, cancelAnimationFrame: noop,
  };
  compileFunction(compiled, Object.keys(globals), { filename: "mcp-app.fixture.cjs" })(...Object.values(globals));
  function render() {
    for (let iteration = 0; dirty; iteration++) {
      assert.ok(iteration < 30, "Hook fixture converges");
      dirty = false; cursor = 0; effects = [];
      tree = module.exports.ExcalidrawAppCore({ app, events });
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
    }
  }
  async function settle() {
    for (let turn = 0; turn < 30; turn++) { await Promise.resolve(); render(); }
  }
  function nodes(value: any): Node[] {
    if (Array.isArray(value)) return value.flatMap((child) => nodes(child));
    return value && typeof value === "object" && "props" in value ? [value, ...nodes(value.props.children)] : [];
  }
  const text = (value: any): string => Array.isArray(value) ? value.map(text).join(" ")
    : value && typeof value === "object" && "props" in value ? text(value.props.children)
    : typeof value === "string" || typeof value === "number" ? String(value) : "";
  render();
  return {
    calls, contexts, downloads, settle,
    async emit(event: appEvents.WidgetEvent) { events.publish(event); await settle(); },
    replayEffects() {
      for (const hook of hooks) hook.cleanup?.();
      for (const hook of hooks) if (hook.effect) hook.cleanup = hook.effect() ?? undefined;
      render();
    },
    editor: () => nodes(tree).find((node) => node.type === Excalidraw),
    preview: () => nodes(tree).find((node) => typeof node.type === "function" && node.type.name === "DiagramView")?.props.scene as SceneData | undefined,
    text: () => text(tree),
    button(label: string) {
      const button = nodes(tree).find((node) => node.type === "button" && text(node) === label);
      assert.ok(button, `Visible button: ${label}`);
      return button.props;
    },
    async edit(scene: SceneData) {
      const editor = nodes(tree).find((node) => node.type === Excalidraw);
      assert.ok(editor, "The actual component mounted its editor");
      editor.props.onChange(scene.elements, { ...scene.appState, width: 0, height: 0 }, scene.files);
      await settle();
    },
    async dispose() {
      for (const hook of hooks) hook.cleanup?.();
      await settle();
    },
  };
}
