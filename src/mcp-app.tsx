import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { Excalidraw, exportToSvg, exportToBlob, getCommonBounds, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import morphdom from "morphdom";
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { initPencilAudio, playStroke, stopPencilAudio } from "./pencil-audio.js";
import { APP_INFO } from "./metadata.js";
import { hasLiveImages, IMAGE_SHARING_MESSAGE } from "./sharing.js";
import { createRenderQueue } from "./render-queue.js";
import { createEditController, resultError, type EditState } from "./edit-context.js";
import { createAppEventBuffer, type AppEventBuffer, type WidgetEvent } from "./app-events.js";
import { findRestoreCheckpoint, parseElementsInput, parseSceneData, reduceSceneOperations, type SceneData, type SceneOperation, type ViewportRect } from "./scene.js";
import { loadSceneFonts, nativeAppState, nativeElements, nativeFiles, serializeScene, toNativeScene } from "./widget-scene.js";
import "./global.css";

function log(app: App, message: string): void {
  try { void app.sendLog({ level: "info", logger: "Excalidraw", data: message }).catch(() => {}); } catch { /* The bridge may already be closed. */ }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 8000); })]);
  } finally { clearTimeout(timer); }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inputArguments(input: unknown): Record<string, unknown> {
  if (!isObject(input)) throw new Error("Diagram input must be an object.");
  return input.arguments && isObject(input.arguments) ? input.arguments : input;
}

/** Extract only fully closed top-level items, including camera/delete-only updates. */
function previewOperations(json: string): SceneOperation[] {
  try { return parseElementsInput(json); } catch { /* The last object may still be streaming. */ }
  let depth = 0, end = -1;
  let quoted = false, escaped = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (char === "}" && depth === 1) end = index;
    }
  }
  return end < 0 ? [] : parseElementsInput(`${json.slice(0, end + 1)}]`);
}

async function readCheckpoint(app: App, id: string): Promise<{ scene: SceneData; revision: number; warning: string }> {
  const result = await app.callServerTool({ name: "read_checkpoint", arguments: { id } });
  if (result.isError) throw new Error(resultError(result));
  const text = result.content.find((item) => item.type === "text");
  const value: unknown = result.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : null);
  const revision = isObject(value) ? value.revision : undefined;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new Error("The checkpoint has no valid revision. Download the diagram and reload.");
  const recovery = isObject(value) ? value.recovery : undefined;
  const missingImages = isObject(recovery) ? recovery.missingFileIds : undefined;
  const warning = Array.isArray(missingImages) && missingImages.length
    ? "Some images in this legacy checkpoint are unavailable. Import the original .excalidraw file to recover them. The original checkpoint has not been overwritten."
    : "";
  return { scene: parseSceneData(value), revision: Number(revision), warning };
}

function downloadScene(scene: SceneData, recovery = false): void {
  const url = URL.createObjectURL(new Blob([serializeScene(scene)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = recovery ? "diagram-recovery.excalidraw" : "diagram.excalidraw";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ShareButtonProps {
  onConfirm: () => Promise<void>;
  onError: (error: unknown) => void;
  compact?: boolean;
  imageRestricted?: boolean;
  descriptionId?: string;
  disabled?: boolean;
}

function ShareButton({
  onConfirm, onError, compact = false, imageRestricted = false, descriptionId, disabled = false,
}: ShareButtonProps): ReactElement {
  const [uploading, setUploading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const dialogDescriptionId = useId();
  return <>
    <button type="button" ref={trigger} className="app-button" aria-label="Open in Excalidraw" disabled={disabled || uploading || imageRestricted}
      aria-describedby={imageRestricted ? descriptionId : undefined} title={imageRestricted ? IMAGE_SHARING_MESSAGE : undefined}
      onClick={() => dialog.current?.showModal()}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M9 2h5v5M14 2 6 10M7 3H2v11h11V9" />
      </svg>
      {!compact && (uploading ? "Exporting…" : "Open in Excalidraw")}
    </button>
    <dialog ref={dialog} className="export-modal" aria-labelledby={titleId} aria-describedby={dialogDescriptionId}
      onCancel={(event) => { event.stopPropagation(); }}
      onClose={() => { if (!uploading) trigger.current?.focus(); }}>
      <h2 id={titleId} className="export-modal-title">Upload to Excalidraw?</h2>
      <p id={dialogDescriptionId} className="export-modal-text">This uploads your diagram to excalidraw.com and opens it in a new tab. Download a local copy instead to keep it private.</p>
      <div className="export-modal-actions">
        <button type="button" className="app-button" autoFocus onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="app-button" disabled={disabled || imageRestricted || uploading} onClick={async () => {
          setUploading(true); dialog.current?.close();
          try { await onConfirm(); } catch (error) { onError(error); }
          finally { setUploading(false); requestAnimationFrame(() => trigger.current?.focus()); }
        }}>Upload and open</button>
      </div>
    </dialog>
  </>;
}

const EXPORT_PADDING = 20;

interface DiagramViewProps {
  scene: SceneData | null;
  fullscreen: boolean;
  animate: boolean;
  audio: boolean;
  onError: (error: unknown) => void;
}

function DiagramView({ scene, fullscreen, animate, audio, onError }: DiagramViewProps): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const frame = useRef(0);
  const previousIds = useRef(new Set<string>());
  const viewBox = useRef<ViewportRect | null>(null);
  const zoom = useRef({ scale: 1, x: 0, y: 0 });
  const [renderQueue] = useState(() => createRenderQueue(onError));
  const applyViewBox = useCallback(() => {
    const svg = container.current?.querySelector("svg");
    const box = viewBox.current;
    if (!svg || !box) return;
    const width = box.width / zoom.current.scale, height = box.height / zoom.current.scale;
    svg.setAttribute("viewBox", `${box.x + (box.width - width) / 2 + zoom.current.x} ${box.y + (box.height - height) / 2 + zoom.current.y} ${width} ${height}`);
  }, []);

  useEffect(() => {
    const epoch = ++generation.current;
    cancelAnimationFrame(frame.current);
    if (!scene || !container.current) return;
    if (!scene.elements.length) {
      container.current.replaceChildren();
      previousIds.current.clear();
      viewBox.current = null;
      return;
    }
    void renderQueue.enqueue(async () => {
      if (epoch !== generation.current) return;
      try {
        const svg = await withDeadline<SVGSVGElement>(exportToSvg({
          elements: nativeElements(scene), files: nativeFiles(scene),
          appState: { ...nativeAppState(scene), exportBackground: true }, exportPadding: EXPORT_PADDING,
        }), "The diagram preview timed out. Try reloading the diagram.");
        if (epoch !== generation.current || !container.current) return;
        const bounds = getCommonBounds(nativeElements(scene));
        const [x, y, width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
        const target = scene.viewport ? {
          x: scene.viewport.x - bounds[0] + EXPORT_PADDING,
          y: scene.viewport.y - bounds[1] + EXPORT_PADDING,
          width: scene.viewport.width, height: scene.viewport.height,
        } : { x, y, width, height };
        if (target.width / target.height > 4 / 3) {
          const expanded = target.width * 3 / 4;
          target.y -= (expanded - target.height) / 2; target.height = expanded;
        } else {
          const expanded = target.height * 4 / 3;
          target.x -= (expanded - target.width) / 2; target.width = expanded;
        }
        svg.removeAttribute("width"); svg.removeAttribute("height");
        svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Excalidraw diagram");
        svg.style.width = "100%"; svg.style.height = "100%";
        const existing = container.current.querySelector("svg");
        if (existing) morphdom(existing, svg);
        else container.current.append(svg);
        if (audio) {
          for (const element of scene.elements.filter((item) => !previousIds.current.has(item.id)).slice(0, 4)) playStroke(element.type);
        }
        previousIds.current = new Set(scene.elements.map((element) => element.id));
        const start = viewBox.current;
        if (!animate || !start || !scene.viewport) { viewBox.current = target; applyViewBox(); return; }
        const began = performance.now();
        const tick = () => {
          if (epoch !== generation.current) return;
          const amount = Math.min(1, (performance.now() - began) / 300);
          const eased = 1 - (1 - amount) ** 3;
          viewBox.current = {
            x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased,
            width: start.width + (target.width - start.width) * eased, height: start.height + (target.height - start.height) * eased,
          };
          applyViewBox();
          if (amount < 1) frame.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) { if (epoch === generation.current) onError(error); }
    });
    return () => { generation.current++; renderQueue.clear(); cancelAnimationFrame(frame.current); };
  }, [scene, animate, audio, onError, applyViewBox, renderQueue]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey && zoom.current.scale === 1) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) zoom.current.scale = Math.max(0.25, Math.min(8, zoom.current.scale * (event.deltaY > 0 ? 0.97 : 1.03)));
      else if (viewBox.current) {
        zoom.current.x += event.deltaX / Math.max(1, element.clientWidth) * viewBox.current.width / zoom.current.scale;
        zoom.current.y += event.deltaY / Math.max(1, element.clientHeight) * viewBox.current.height / zoom.current.scale;
      }
      applyViewBox();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [applyViewBox]);

  const resetZoom = () => { zoom.current = { scale: 1, x: 0, y: 0 }; applyViewBox(); };
  return <div className={`diagram-preview${fullscreen ? " diagram-fullscreen" : ""}`}>
    <div ref={container} className="excalidraw-container svg-wrapper" tabIndex={0}
      role="region" aria-label="Diagram preview. Use plus and minus to zoom, arrow keys to pan, and zero to reset."
      onDoubleClick={resetZoom}
      onKeyDown={(event) => {
        if (event.key === "+" || event.key === "=") zoom.current.scale = Math.min(8, zoom.current.scale * 1.2);
        else if (event.key === "-") zoom.current.scale = Math.max(0.25, zoom.current.scale / 1.2);
        else if (event.key === "0") { resetZoom(); return; }
        else if (event.key === "ArrowLeft") zoom.current.x -= 20 / zoom.current.scale;
        else if (event.key === "ArrowRight") zoom.current.x += 20 / zoom.current.scale;
        else if (event.key === "ArrowUp") zoom.current.y -= 20 / zoom.current.scale;
        else if (event.key === "ArrowDown") zoom.current.y += 20 / zoom.current.scale;
        else return;
        event.preventDefault(); applyViewBox();
      }} />
    {scene && !scene.elements.length && <p className="empty-diagram">The diagram is empty. Choose Edit to start drawing.</p>}
  </div>;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setMatches(media.matches);
    media.addEventListener("change", change);
    change();
    return () => media.removeEventListener("change", change);
  }, [query]);
  return matches;
}

interface ExcalidrawAppCoreProps {
  app: App;
  events: AppEventBuffer;
}

interface CheckpointReference {
  id: string;
  revision: number;
  warning?: string;
}

export function ExcalidrawAppCore({ app, events }: ExcalidrawAppCoreProps): ReactElement {
  const [scene, setScene] = useState<SceneData | null>(null);
  const [isFinal, setIsFinal] = useState(false);
  const [checkpointReady, setCheckpointReady] = useState(false);
  const [hostContext, setHostContext] = useState<McpUiHostContext>(() => app.getHostContext() ?? {});
  const [saveState, setSaveState] = useState<EditState>({ status: "saved", revision: 0 });
  const [error, setError] = useState("");
  const [feedbackError, setFeedbackError] = useState("");
  const [checkpointWarning, setCheckpointWarning] = useState("");
  const [audio, setAudio] = useState(false);
  const [motion, setMotion] = useState(true);
  const [editorKey, setEditorKey] = useState(0);
  const [editorReady, setEditorReady] = useState(false);
  const imageSharingDescriptionId = useId();
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const isNarrow = useMedia("(max-width: 640px)");
  const sceneRef = useRef<SceneData | null>(null);
  const editorData = useRef<Parameters<NonNullable<ExcalidrawProps["onChange"]>> | null>(null);
  const initialEditorViewport = useRef<ViewportRect | null>(null);
  const [editorAppState, setEditorAppState] = useState<Partial<AppState>>({});
  const editorInvalid = useRef(false);
  const inputGeneration = useRef(0);
  const editorChangeVersion = useRef(0);
  const acceptedSignature = useRef("");
  const finalSignature = useRef("");
  const rejectedInput = useRef(false);
  const lastCheckpoint = useRef<CheckpointReference | null>(null);
  const userEdited = useRef(false);
  const mounted = useRef(true);
  const feedbackGeneration = useRef(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedbackQueue = useRef(Promise.resolve());
  const sendFeedbackRef = useRef<(scene: SceneData, revision: number, summary: string, checkpointId: string) => void>(() => {});
  const reportError = useCallback((problem: unknown) => {
    if (mounted.current) setError(errorMessage(problem));
    log(app, errorMessage(problem));
  }, [app]);

  const [controller] = useState(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Some hosts disallow localStorage. */ }
    return createEditController({
      storage,
      save: (args) => app.callServerTool({ name: "save_checkpoint", arguments: args }, { timeout: 8000 }),
      onState: (state) => { if (mounted.current) setSaveState(state); },
      onSaved: (saved, revision, summary, checkpointId) => {
        if (mounted.current) setCheckpointWarning("");
        if (lastCheckpoint.current?.id === checkpointId) {
          lastCheckpoint.current.warning = undefined;
          lastCheckpoint.current.revision = revision;
        }
        sendFeedbackRef.current(saved, revision, summary, checkpointId);
      },
    });
  });

  sendFeedbackRef.current = (saved, revision, summary, checkpointId) => {
    if (!mounted.current) return;
    const capability = app.getHostCapabilities()?.updateModelContext;
    if (!capability || (!capability.text && !capability.image)) return;
    const epoch = ++feedbackGeneration.current;
    setFeedbackError("");
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => {
      // Serialize sends: an older in-flight request cannot arrive after a newer summary.
      feedbackQueue.current = feedbackQueue.current.catch(() => {}).then(async () => {
        if (epoch !== feedbackGeneration.current) return;
        const content: NonNullable<Parameters<App["updateModelContext"]>[0]["content"]> = [];
        const text = `Diagram checkpoint ${checkpointId}, saved revision ${revision}. ${summary || "Diagram ready."}`;
        if (capability.text) content.push({ type: "text", text });
        try {
          if (capability.image && saved.elements.length) {
            await loadSceneFonts(saved);
            const blob = await withDeadline<Blob>(exportToBlob({
              elements: nativeElements(saved), files: nativeFiles(saved), appState: { ...nativeAppState(saved), exportBackground: true },
              maxWidthOrHeight: 512, mimeType: "image/png",
            }), "The diagram snapshot timed out.");
            if (blob.size > 1024 * 1024) throw new Error("The diagram snapshot exceeded the 1 MB limit.");
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            content.push({ type: "image", mimeType: "image/png", data: btoa(binary) });
          }
        } catch (problem) {
          if (epoch === feedbackGeneration.current && mounted.current) setFeedbackError("The visual snapshot could not be sent. Your diagram is still saved.");
          log(app, `Snapshot: ${errorMessage(problem)}`);
        }
        if (epoch !== feedbackGeneration.current || (!content.length && saved.elements.length)) return;
        try { await app.updateModelContext({ content }, { timeout: 8000 }); }
        catch (problem) {
          if (mounted.current && epoch === feedbackGeneration.current) setFeedbackError("The host could not receive diagram feedback. Your diagram is still saved.");
          log(app, `Model feedback: ${errorMessage(problem)}`);
        }
      });
    }, 1500);
  };

  const flush = useCallback(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([controller.flush(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2500); })]);
    } finally { clearTimeout(timer); }
    if (controller.hasChanges()) log(app, "Unsaved edits remain in the local recovery copy; teardown/exit saving was not acknowledged.");
  }, [app, controller]);

  const applyScene = useCallback((value: SceneData, checkpoint: { id: string; revision: number } | null, final: boolean) => {
    sceneRef.current = value; setScene(value); setIsFinal(final);
    if (final) {
      finalSignature.current = acceptedSignature.current;
      editorData.current = null;
      editorInvalid.current = false;
      controller.initialize(checkpoint?.id ?? null, checkpoint?.revision ?? 0, value);
      setCheckpointReady(!!checkpoint);
      userEdited.current = false;
      setEditorKey((key) => key + 1);
      if (checkpoint) sendFeedbackRef.current(value, checkpoint.revision, "", checkpoint.id);
    }
  }, [controller]);

  const editsAreProtected = useCallback(() => (
    userEdited.current || editorInvalid.current || controller.hasChanges() || controller.getState().status === "saving"
  ), [controller]);

  const loadServerCopy = useCallback(async (replaceEdits = false, checkpoint = lastCheckpoint.current) => {
    if (!checkpoint) return;
    const changesAtStart = editorChangeVersion.current;
    const sceneAtStart = controller.getScene();
    const epoch = ++inputGeneration.current;
    try {
      const saved = await readCheckpoint(app, checkpoint.id);
      try { await loadSceneFonts(saved.scene); } catch (problem) { log(app, errorMessage(problem)); }
      if (epoch !== inputGeneration.current) return;
      if (changesAtStart !== editorChangeVersion.current || sceneAtStart !== controller.getScene() ||
        (!replaceEdits && editsAreProtected())) {
        reportError("The checkpoint changed while this diagram has local edits. Download your edits before reloading the server copy.");
        return;
      }
      const native = toNativeScene(saved.scene);
      lastCheckpoint.current = { ...checkpoint, revision: saved.revision };
      applyScene(native, lastCheckpoint.current, true);
      setCheckpointWarning([checkpoint.warning, saved.warning].filter(Boolean).join("\n"));
      setError("");
    } catch (problem) { if (epoch === inputGeneration.current) reportError(problem); }
  }, [app, applyScene, controller, editsAreProtected, reportError]);

  useEffect(() => {
    mounted.current = true;
    const handleEvent = (event: WidgetEvent) => {
      if (event.type === "context") {
        if (event.value.displayMode && event.value.displayMode !== "fullscreen") {
          const edited = lastCheckpoint.current ? controller.getScene() : null;
          if (edited) { sceneRef.current = edited; setScene(edited); }
          void flush();
        }
        setHostContext((previous) => ({ ...previous, ...event.value }));
        return;
      }
      if (event.type === "error" || event.type === "cancelled") {
        if (rejectedInput.current || editsAreProtected()) {
          reportError(event.type === "cancelled" ? "New diagram generation was cancelled. Your local edits are still available." : event.value);
          return;
        }
        inputGeneration.current++;
        feedbackGeneration.current++;
        setIsFinal(false);
        reportError(event.type === "cancelled" ? "Diagram generation was cancelled. The last preview is still available." : event.value);
        return;
      }
      if (event.type === "result") {
        const data = event.value.structuredContent;
        if (lastCheckpoint.current?.id === data?.checkpointId && userEdited.current) return;
        if (rejectedInput.current || editsAreProtected()) {
          reportError("New diagram output arrived while this diagram has local edits. Download your edits before reloading the server copy.");
          return;
        }
        if (event.value.isError) {
          inputGeneration.current++; setCheckpointReady(false);
          reportError(resultError(event.value)); return;
        }
        if (typeof data?.checkpointId !== "string" || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0) {
          reportError("The server did not acknowledge a checkpoint revision. Download a local copy before closing.");
          return;
        }
        feedbackGeneration.current++;
        clearTimeout(feedbackTimer.current);
        if (!lastCheckpoint.current) setCheckpointReady(false);
        const warning = Array.isArray(data.warnings) ? data.warnings.filter((value): value is string => typeof value === "string").join("\n") : undefined;
        void loadServerCopy(false, { id: data.checkpointId, revision: Number(data.revision), warning });
        return;
      }
      let args: Record<string, unknown>;
      try { args = inputArguments(event.value); } catch (problem) { if (event.type === "input") reportError(problem); return; }
      const final = event.type === "input";
      const signature = JSON.stringify(args);
      if (final && signature === finalSignature.current) return;
      if (editsAreProtected()) {
        rejectedInput.current = true;
        reportError("New diagram input arrived while this diagram has local edits. Download your edits before reloading the server copy.");
        return;
      }
      rejectedInput.current = false;
      lastCheckpoint.current = null;
      editorData.current = null;
      setCheckpointReady(false);
      feedbackGeneration.current++;
      clearTimeout(feedbackTimer.current);
      acceptedSignature.current = final ? signature : "";
      finalSignature.current = "";
      const epoch = ++inputGeneration.current;
      setIsFinal(false); setError("");
      void (async () => {
        try {
          if (final && (args.scene !== undefined) === (args.elements !== undefined)) {
            throw new Error("Provide exactly one scene or elements JSON string.");
          }
          let next: SceneData;
          let inheritedWarning = "";
          if (typeof args.scene === "string") next = parseSceneData(JSON.parse(args.scene));
          else {
            if (typeof args.elements !== "string") {
              if (!final) return;
              throw new Error("Diagram input needs an elements or scene JSON string.");
            }
            const operations = final ? parseElementsInput(args.elements) : previewOperations(args.elements);
            const restoreId = findRestoreCheckpoint(operations);
            const base = restoreId ? await readCheckpoint(app, restoreId) : undefined;
            inheritedWarning = base?.warning ?? "";
            next = reduceSceneOperations(operations, base?.scene);
          }
          try { await loadSceneFonts(next); } catch (problem) { log(app, errorMessage(problem)); }
          if (epoch !== inputGeneration.current) return;
          next = toNativeScene(next);
          if (final) setCheckpointWarning(inheritedWarning);
          applyScene(next, null, final);
        } catch (problem) {
          if (final && epoch === inputGeneration.current) reportError(`Unable to load this diagram: ${errorMessage(problem)} Ask for corrected input, or download the last preview.`);
        }
      })();
    };
    setHostContext(app.getHostContext() ?? {});
    const unsubscribe = events.subscribe(handleEvent, async () => {
      await flush();
      if (controller.hasChanges() || editorInvalid.current) throw new Error("Checkpoint save was not acknowledged. Download unsaved edits before closing.");
    });
    const onPageHide = () => { void flush(); };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mounted.current = false;
      unsubscribe(); inputGeneration.current++; feedbackGeneration.current++;
      clearTimeout(feedbackTimer.current);
      window.removeEventListener("pagehide", onPageHide);
      void controller.dispose();
    };
  }, [app, events, applyScene, controller, editsAreProtected, flush, loadServerCopy, reportError]);

  const fullscreen = hostContext.displayMode === "fullscreen";
  const availableModes = hostContext.availableDisplayModes ?? [];
  const canEdit = availableModes.includes("fullscreen");
  const height = hostContext.containerDimensions && "height" in hostContext.containerDimensions ? hostContext.containerDimensions.height : undefined;
  const toggleFullscreen = useCallback(async () => {
    const mode = fullscreen ? "inline" : "fullscreen";
    if (!availableModes.includes(mode)) { reportError("This host does not support that display mode."); return; }
    if (fullscreen) {
      const edited = controller.getScene();
      if (edited) { sceneRef.current = edited; setScene(edited); }
      await flush();
      if (editorInvalid.current) { reportError("These edits cannot be saved. Download a local copy before leaving the editor."); return; }
    }
    try {
      const result = await app.requestDisplayMode({ mode });
      setHostContext((previous) => ({ ...previous, displayMode: result.mode }));
      if (result.mode !== mode) reportError("The host kept the current display mode.");
    } catch (problem) { reportError(problem); }
  }, [app, availableModes, controller, flush, fullscreen, reportError]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open], [role='dialog']")) return;
      if (fullscreen) void toggleFullscreen();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [fullscreen, toggleFullscreen]);

  useEffect(() => {
    const root = document.documentElement;
    const insets = hostContext.safeAreaInsets;
    const values = { "--sat": insets?.top, "--sar": insets?.right, "--sab": insets?.bottom, "--sal": insets?.left };
    for (const [key, value] of Object.entries(values)) root.style.setProperty(key, fullscreen ? `${value ?? 0}px` : "0px");
    root.style.height = fullscreen && height ? `${height}px` : "";
    document.body.style.height = root.style.height;
    return () => {
      for (const key of Object.keys(values)) root.style.removeProperty(key);
      root.style.height = ""; document.body.style.height = "";
    };
  }, [fullscreen, height, hostContext.safeAreaInsets]);

  useEffect(() => {
    let cancelled = false;
    setEditorReady(false);
    initialEditorViewport.current = null;
    if (fullscreen && sceneRef.current && isFinal && checkpointReady) {
      void loadSceneFonts(sceneRef.current).catch((problem) => log(app, errorMessage(problem))).then(() => {
        if (cancelled || !sceneRef.current) return;
        const current = sceneRef.current;
        const preview = document.querySelector(".diagram-preview")?.getBoundingClientRect();
        const viewport = current.viewport;
        const zoom = viewport ? Math.max(0.1, Math.min(30, (preview?.width || window.innerWidth) / viewport.width, (preview?.height || window.innerHeight) / viewport.height)) : 1;
        setEditorAppState({
          ...nativeAppState(current),
          ...(viewport ? { scrollX: -viewport.x, scrollY: -viewport.y, zoom: { value: zoom as AppState["zoom"]["value"] } } : {}),
        });
        setEditorReady(true);
      });
    }
    return () => { cancelled = true; };
  }, [app, fullscreen, isFinal, checkpointReady, editorKey]);

  const currentScene = () => userEdited.current ? controller.getScene() ?? sceneRef.current : sceneRef.current;
  const canOpenLinks = !!app.getHostCapabilities()?.openLinks;
  const canShare = canOpenLinks && !!app.getHostCapabilities()?.serverTools;
  const imageSharingRestricted = () => hasLiveImages(editorData.current?.[0] ?? currentScene()?.elements ?? []);
  const containsImages = imageSharingRestricted();
  const currentJSON = () => {
    if (editorData.current) {
      const [elements, appState, files] = editorData.current;
      return serializeAsJSON(elements, appState, files, "local");
    }
    const current = currentScene();
    if (!current) throw new Error("Wait for a diagram before exporting.");
    return serializeScene(current);
  };
  const share = async () => {
    if (!isFinal || !checkpointReady) throw new Error("Wait for the diagram to finish before sharing.");
    if (!canShare) throw new Error("This host cannot open sharing links. Download the diagram instead.");
    if (imageSharingRestricted()) throw new Error(IMAGE_SHARING_MESSAGE);
    const result = await app.callServerTool({ name: "export_to_excalidraw", arguments: { json: currentJSON() } });
    if (result.isError) throw new Error(resultError(result));
    const text = result.content.find((item) => item.type === "text");
    let url = "";
    if (typeof result.structuredContent?.url === "string") {
      url = result.structuredContent.url;
    } else if (text?.type === "text") {
      url = text.text;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "excalidraw.com") throw new Error("The server returned an invalid sharing link.");
    await app.openLink({ url: parsed.href });
  };
  const download = (value = currentScene(), recovery = false) => {
    if (!value) return;
    try {
      if (editorData.current && !recovery) {
        const link = document.createElement("a");
        const url = URL.createObjectURL(new Blob([currentJSON()], { type: "application/json" }));
        link.href = url; link.download = "diagram.excalidraw"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else downloadScene(value, recovery);
    } catch (problem) { reportError(problem); }
  };
  const mountEditor = fullscreen && isFinal && checkpointReady && scene !== null && editorReady;
  let saveLabel = "Diagram preview";
  if (checkpointReady) {
    saveLabel = {
      saved: `Saved · revision ${saveState.revision}`,
      dirty: "Unsaved changes",
      saving: "Saving…",
      error: "Save failed · edits kept locally where available",
      conflict: "Revision conflict · server copy was not overwritten",
    }[saveState.status];
  } else if (isFinal) {
    saveLabel = "Waiting for checkpoint acknowledgement";
  }

  return <main className={`main${fullscreen ? " fullscreen" : ""}${!motion || reducedMotion ? " reduce-motion" : ""}`}
    style={fullscreen && height ? { height } : undefined}>
    <div className={`toolbar${fullscreen ? " fullscreen-actions" : ""}`} aria-label="Diagram actions" role="group">
      {!mountEditor && canShare && <ShareButton onConfirm={share} onError={reportError} compact={isNarrow}
        disabled={!isFinal || !checkpointReady} imageRestricted={containsImages} descriptionId={imageSharingDescriptionId} />}
      <button type="button" className="app-button" disabled={!scene} onClick={() => download()}>Download</button>
      {!fullscreen && <>
        <button type="button" className="app-button" aria-pressed={audio} onClick={async () => {
          if (!audio) { try { await initPencilAudio(); setAudio(true); } catch (problem) { reportError(problem); } }
          else { stopPencilAudio(); setAudio(false); }
        }}>Pencil sounds</button>
        <button type="button" className="app-button" aria-pressed={motion && !reducedMotion} disabled={reducedMotion}
          title={reducedMotion ? "Your reduced-motion preference is enabled" : undefined} onClick={() => setMotion(!motion)}>Animate diagram</button>
      </>}
      {(fullscreen || canEdit) && <button type="button" className="app-button" disabled={!isFinal || !checkpointReady}
        onClick={() => { void toggleFullscreen(); }}>{fullscreen ? "Exit fullscreen" : "Edit"}</button>}
    </div>
    <div className="diagram-status">
      <p role="status" aria-live="polite">{saveLabel}</p>
      <p role="alert">{error || saveState.error}</p>
      <p role="status">{checkpointWarning}</p>
      <p role="status">{feedbackError}</p>
      {containsImages && <div className="recovery-actions">
        <p id={imageSharingDescriptionId} role="status">{IMAGE_SHARING_MESSAGE}</p>
        <button type="button" className="app-button" onClick={() => download()}>Download .excalidraw with images</button>
      </div>}
      {(saveState.status === "error" || saveState.status === "conflict") && <div className="recovery-actions">
        {saveState.status === "error" && <button type="button" className="app-button" onClick={() => { void controller.retry(); }}>Retry save</button>}
        <button type="button" className="app-button" onClick={() => download()}>Download unsaved edits</button>
        <button type="button" className="app-button" onClick={() => { void loadServerCopy(true); }}>Reload server copy</button>
      </div>}
      {saveState.recovery && <div className="recovery-actions">
        <span>{saveState.recovery.message ?? `Unsaved recovery copy from revision ${saveState.recovery.revision}. The server copy is shown.`}</span>
        <button type="button" className="app-button" onClick={() => download(saveState.recovery?.scene, true)}>Download recovery copy</button>
        {saveState.recovery.revision === saveState.revision && <button type="button" className="app-button" onClick={() => {
          const recovered = controller.restoreRecovery();
          if (recovered) {
            sceneRef.current = recovered; setScene(recovered); userEdited.current = true; setEditorKey((key) => key + 1);
          }
        }}>Restore unsaved edits</button>}
      </div>}
    </div>
    {mountEditor ? <div className="editor-container">
      <Excalidraw key={editorKey}
        initialData={{ elements: nativeElements(scene), files: nativeFiles(scene), appState: editorAppState, scrollToContent: !scene.viewport }}
        theme={hostContext.theme ?? "light"}
        onChange={(elements, appState, files) => {
          if (!lastCheckpoint.current) return;
          editorData.current = [elements, appState, files];
          try {
            const liveViewport = appState.width > 0 && appState.height > 0 ? {
              x: -appState.scrollX, y: -appState.scrollY,
              width: appState.width / appState.zoom.value, height: appState.height / appState.zoom.value,
            } : null;
            initialEditorViewport.current ??= liveViewport;
            const viewport = liveViewport && JSON.stringify(liveViewport) !== JSON.stringify(initialEditorViewport.current)
              ? liveViewport : sceneRef.current?.viewport;
            const next = parseSceneData({ schemaVersion: 1, elements: elements.filter((element) => !element.isDeleted), appState, files, viewport });
            const previous = controller.getScene();
            controller.change(next);
            if (controller.getScene() !== previous) editorChangeVersion.current++;
            if (controller.hasChanges()) userEdited.current = true;
            if (editorInvalid.current) { editorInvalid.current = false; setError(""); }
          } catch (problem) {
            editorChangeVersion.current++;
            editorInvalid.current = true; userEdited.current = true; reportError(problem);
          }
        }}
        renderTopRightUI={isNarrow || !canShare ? undefined : () => <ShareButton onConfirm={share} onError={reportError}
          disabled={!isFinal || !checkpointReady}
          imageRestricted={containsImages} descriptionId={imageSharingDescriptionId} />}>
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.Item onSelect={() => download()}>Download .excalidraw</MainMenu.Item>
          {canOpenLinks && <><MainMenu.Separator />
          <MainMenu.Item onSelect={() => { void app.openLink({ url: "https://plus.excalidraw.com?utm_source=mcp_app_menu" }).catch(reportError); }}>Excalidraw</MainMenu.Item>
          <MainMenu.Item onSelect={() => { void app.openLink({ url: "https://github.com/excalidraw/excalidraw" }).catch(reportError); }}>GitHub</MainMenu.Item>
          <MainMenu.Item onSelect={() => { void app.openLink({ url: "https://x.com/excalidraw" }).catch(reportError); }}>Follow us</MainMenu.Item>
          <MainMenu.Item onSelect={() => { void app.openLink({ url: "https://discord.gg/UexuTaE" }).catch(reportError); }}>Discord chat</MainMenu.Item></>}
        </MainMenu>
      </Excalidraw>
      {isNarrow && canShare && <div className="mobile-share-slot"><ShareButton compact onConfirm={share} onError={reportError}
        disabled={!isFinal || !checkpointReady}
        imageRestricted={containsImages} descriptionId={imageSharingDescriptionId} /></div>}
    </div> : <DiagramView scene={scene} fullscreen={fullscreen} animate={motion && !reducedMotion} audio={audio && !isFinal} onError={reportError} />}
  </main>;
}

export function ExcalidrawApp(): ReactElement {
  const [events] = useState(createAppEventBuffer);
  const { app, error, isConnected } = useApp({
    appInfo: APP_INFO, capabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    onAppCreated: (created) => events.register(created),
  });
  if (error) return <div className="error" role="alert">Unable to connect: {error.message}</div>;
  if (!app || !isConnected) return <div className="loading" role="status">Connecting…</div>;
  return <ExcalidrawAppCore app={app} events={events} />;
}
