import { parseSceneData, recoverLegacySceneData, type SceneData } from "./scene.js";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";
export interface SaveResult {
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  content?: readonly { type: string; text?: string }[];
}
export interface EditState {
  status: SaveStatus;
  revision: number;
  error?: string;
  recovery?: { scene: SceneData; revision: number; message?: string };
}
export interface EditController {
  initialize(checkpointId: string | null, revision: number, scene: SceneData): SceneData;
  change(scene: SceneData): void;
  attach(checkpointId: string, revision: number): void;
  getScene(): SceneData | null;
  getState(): EditState;
  hasChanges(): boolean;
  flush(): Promise<void>;
  retry(): Promise<void>;
  restoreRecovery(): SceneData | null;
  dispose(): Promise<void>;
}

interface CachedScene {
  scene: SceneData;
  revision: number;
  dirty: boolean;
  recovery?: EditState["recovery"];
}

function readCache(value: unknown): CachedScene {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !("revision" in value) || typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !("dirty" in value) || typeof value.dirty !== "boolean" || !("scene" in value)) {
    throw new Error("Invalid cached checkpoint.");
  }
  let recovery: EditState["recovery"];
  if ("recovery" in value && value.recovery !== undefined) {
    const saved = value.recovery;
    if (!saved || typeof saved !== "object" || !("scene" in saved) ||
      !("revision" in saved) || typeof saved.revision !== "number" ||
      !Number.isSafeInteger(saved.revision) || saved.revision < -1 ||
      ("message" in saved && saved.message !== undefined && typeof saved.message !== "string")) {
      throw new Error("Invalid cached recovery revision.");
    }
    recovery = {
      scene: parseSceneData(saved.scene), revision: saved.revision,
      ...("message" in saved && typeof saved.message === "string" ? { message: saved.message.slice(0, 500) } : {}),
    };
  }
  return { scene: parseSceneData(value.scene), revision: value.revision, dirty: value.dirty, recovery };
}
interface ControllerOptions {
  save: (args: { id: string; data: string; expectedRevision: number }) => Promise<SaveResult>;
  storage?: Pick<Storage, "getItem" | "setItem">;
  onState?: (state: EditState) => void;
  onSaved?: (scene: SceneData, revision: number, summary: string, checkpointId: string) => void;
  debounceMs?: number;
  retryDelays?: number[];
}

export function resultError(result: SaveResult): string {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") || "The server could not complete this request.";
}

function saveResultFailure(result: SaveResult): Error {
  const message = resultError(result);
  const code = String(result._meta?.code ?? result.structuredContent?.code ?? "");
  const conflict = /conflict|revision/i.test(code) || /revision conflict|stale revision/i.test(message);
  const transient = result._meta?.retryable === true || result.structuredContent?.retryable === true || /unavailable|timeout|temporar|rate.?limit/i.test(code);
  return Object.assign(new Error(message), { conflict, transient });
}

function saveFailureDetails(failure: unknown): { message: string; conflict: boolean; transient: boolean } {
  const details = failure !== null && typeof failure === "object" ? failure : undefined;
  let message = "";
  if (typeof failure === "string") {
    message = failure;
  } else if (details && "message" in details && typeof details.message === "string") {
    message = details.message;
  }
  return {
    message: message.trim() ? message : "Unable to save. Download your edits, then reload the checkpoint.",
    conflict: !!details && "conflict" in details && details.conflict === true,
    transient: failure instanceof TypeError || (!!details && "transient" in details && details.transient === true),
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function meaningfulElement(element: Record<string, unknown>): Record<string, unknown> {
  const { version: _version, versionNonce: _nonce, updated: _updated, ...content } = element;
  return content;
}

export function summarizeSceneChanges(before: SceneData, after: SceneData): string {
  const previous = new Map(before.elements.map((element) => [element.id, element]));
  const current = new Map(after.elements.map((element) => [element.id, element]));
  const changes: string[] = [];
  for (const element of after.elements) {
    const original = previous.get(element.id);
    const name = `${element.type} ${element.id}`;
    if (!original) changes.push(`Added ${name}`);
    else if (stable(meaningfulElement(original)) !== stable(meaningfulElement(element))) {
      const text = typeof element.text === "string" ? `: ${element.text.slice(0, 160)}` : "";
      changes.push(`Changed ${name}${text}`);
    }
  }
  for (const element of before.elements) if (!current.has(element.id)) changes.push(`Removed ${element.type} ${element.id}`);
  if (stable(before.files) !== stable(after.files)) changes.push("Updated image files");
  if (stable(before.appState) !== stable(after.appState)) changes.push("Updated scene settings");
  if (stable(before.viewport) !== stable(after.viewport)) changes.push("Updated viewport");
  return changes.slice(0, 25).join("; ") + (changes.length > 25 ? `; and ${changes.length - 25} more changes` : "");
}

/** One controller per widget. Acknowledgements, not timers, advance the saved baseline. */
export function createEditController(options: ControllerOptions): EditController {
  let id: string | null = null;
  let revision = 0;
  let scene: SceneData | null = null;
  let baseline: SceneData | null = null;
  let savedSignature = "";
  let status: SaveStatus = "saved";
  let error: string | undefined;
  let recovery: EditState["recovery"];
  let cacheError: string | undefined;
  let preserveUnreadCache = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const delays = options.retryDelays ?? [250, 750];

  function dirty(): boolean {
    return !!scene && stable(scene) !== savedSignature;
  }

  function getState(): EditState {
    return { status, revision, error: error ?? cacheError, recovery };
  }

  function emit(): void {
    options.onState?.(getState());
  }

  function cache(): void {
    if (!id || !scene) return;
    if (preserveUnreadCache) return;
    if (!options.storage) {
      if (dirty()) cacheError = "Local recovery storage is unavailable. Download the diagram to keep a copy.";
      return;
    }
    try {
      options.storage.setItem(`excalidraw:${id}`, JSON.stringify({ scene, revision, dirty: dirty(), recovery }));
      cacheError = undefined;
    } catch {
      cacheError = "Local recovery storage is unavailable. Download the diagram to keep a copy.";
    }
  }

  function cancelTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    cancelTimer();
    if (status !== "conflict" && status !== "error" && id && dirty()) {
      timer = setTimeout(() => { void flush(); }, options.debounceMs ?? 1000);
    }
  }

  async function flush(): Promise<void> {
    cancelTimer();
    if (inFlight) {
      await inFlight;
      return;
    }
    if (!id || !scene || !dirty() || status === "conflict" || status === "error") return;
    const epoch = generation;
    const checkpointId = id;
    async function run(): Promise<void> {
      while (epoch === generation && scene && dirty()) {
        const submitted = scene;
        const expectedRevision = revision;
        status = "saving";
        error = undefined;
        emit();
        let attempt = 0;
        while (true) {
          try {
            const result = await options.save({ id: checkpointId, data: JSON.stringify(submitted), expectedRevision });
            if (epoch !== generation) return;
            if (result.isError) throw saveResultFailure(result);
            const nextRevision = result.structuredContent?.revision;
            if (result.structuredContent?.checkpointId !== checkpointId || !Number.isSafeInteger(nextRevision) || Number(nextRevision) <= expectedRevision) {
              throw new Error("Save acknowledgement was incomplete. Reload the checkpoint before retrying; your edits are kept locally.");
            }
            revision = Number(nextRevision);
            const summary = baseline ? summarizeSceneChanges(baseline, submitted) : "";
            baseline = submitted;
            savedSignature = stable(submitted);
            cache();
            status = dirty() ? "dirty" : "saved";
            emit();
            try { options.onSaved?.(submitted, revision, summary, checkpointId); }
            catch {
              error = "The diagram is saved, but its feedback could not be delivered.";
              emit();
            }
            break;
          } catch (failure) {
            if (epoch !== generation) return;
            const problem = saveFailureDetails(failure);
            if (!problem.conflict && problem.transient && attempt < delays.length) {
              await new Promise((resolve) => setTimeout(resolve, delays[attempt++]));
              if (epoch !== generation) return;
              continue;
            }
            status = problem.conflict ? "conflict" : "error";
            error = problem.message;
            cache();
            emit();
            return;
          }
        }
      }
    }
    const pending = run();
    inFlight = pending;
    try {
      await pending;
    } finally {
      if (inFlight === pending) inFlight = undefined;
    }
  }

  return {
    initialize(checkpointId: string | null, nextRevision: number, value: SceneData): SceneData {
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) throw new Error("Invalid checkpoint revision.");
      cancelTimer();
      generation++;
      inFlight = undefined;
      id = checkpointId;
      revision = nextRevision;
      scene = parseSceneData(value);
      baseline = scene;
      savedSignature = stable(scene);
      status = "saved"; error = undefined; recovery = undefined; cacheError = undefined; preserveUnreadCache = false;
      if (id && options.storage) {
        try {
          const raw = options.storage.getItem(`excalidraw:${id}`);
          if (raw) {
            const decoded: unknown = JSON.parse(raw);
            if (Array.isArray(decoded)) {
              // Keep the original bytes before replacing the old element-array cache format.
              options.storage.setItem(`excalidraw:${id}:legacy`, raw);
              const recovered = recoverLegacySceneData({ elements: decoded });
              recovery = {
                scene: recovered.scene, revision: -1,
                message: `A legacy local copy has an unknown revision and is download-only.${recovered.recovery ? " Some image bytes were never cached; only recoverable content can be downloaded." : ""}`,
              };
            } else {
              const cached = readCache(decoded);
              if (cached.dirty && stable(cached.scene) !== savedSignature) {
                recovery = { scene: cached.scene, revision: cached.revision };
              }
              if (!recovery && cached.recovery) recovery = cached.recovery;
            }
          }
        } catch {
          preserveUnreadCache = true;
          cacheError = "The previous local recovery copy was left untouched because it could not be read or archived. New edits cannot be cached; download a copy before closing.";
        }
      }
      cache(); emit();
      return scene;
    },
    change(value: SceneData) {
      const next = parseSceneData(value);
      if (scene && stable(next) === stable(scene)) return;
      scene = next;
      if (status !== "error" && status !== "conflict" && status !== "saving") status = dirty() ? "dirty" : "saved";
      cache(); emit(); schedule();
    },
    attach(checkpointId: string, nextRevision: number) {
      id = checkpointId; revision = nextRevision;
      cache(); emit(); schedule();
    },
    getScene: () => scene,
    getState,
    hasChanges: dirty,
    flush,
    retry() {
      if (status === "conflict") return Promise.resolve();
      status = dirty() ? "dirty" : "saved"; error = undefined; emit();
      return flush();
    },
    restoreRecovery() {
      if (!recovery || recovery.revision !== revision) return null;
      const recovered = recovery.scene;
      recovery = undefined;
      scene = recovered;
      status = "dirty"; error = undefined;
      cache(); emit(); schedule();
      return scene;
    },
    dispose() { cancelTimer(); return flush(); },
  };
}
