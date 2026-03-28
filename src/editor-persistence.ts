import type { App } from "@modelcontextprotocol/ext-apps";
import type { WidgetContextController } from "./widget-context";
import { flushModelContext } from "./widget-context";

const DEBOUNCE_MS = 2000;

function safeLocalStorageGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function buildSnapshot(elements: readonly any[]) {
  return JSON.stringify(elements.map((el: any) => `${el.id}:${el.version ?? 0}`));
}

function computeDiff(current: any[], initialElementsById: Map<string, any>, checkpointId: string | null) {
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const currentIds = new Set<string>();

  for (const el of current) {
    currentIds.add(el.id);
    const original = initialElementsById.get(el.id);
    if (!original) {
      const desc = `${el.type} "${el.text ?? el.label?.text ?? ""}" at (${Math.round(el.x)},${Math.round(el.y)})`;
      added.push(desc);
      continue;
    }

    if (
      Math.round(original.x) !== Math.round(el.x)
      || Math.round(original.y) !== Math.round(el.y)
      || Math.round(original.width) !== Math.round(el.width)
      || Math.round(original.height) !== Math.round(el.height)
    ) {
      moved.push(
        `${el.id} → (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.width)}x${Math.round(el.height)}`,
      );
    }
  }

  for (const id of initialElementsById.keys()) {
    if (!currentIds.has(id)) {
      removed.push(id);
    }
  }

  const parts: string[] = [];
  if (added.length) {
    parts.push(`Added: ${added.join("; ")}`);
  }
  if (removed.length) {
    parts.push(`Removed: ${removed.join(", ")}`);
  }
  if (moved.length) {
    parts.push(`Moved/resized: ${moved.join("; ")}`);
  }
  if (!parts.length) {
    return "";
  }

  const checkpointSuffix = checkpointId ? ` (checkpoint: ${checkpointId})` : "";
  return `User edited diagram${checkpointSuffix}. ${parts.join(". ")}`;
}

export interface EditorPersistenceController {
  setStorageKey(key: string): void;
  loadPersistedElements(): any[] | null;
  captureInitialElements(elements: readonly any[]): void;
  onEditorChange(elements: readonly any[]): void;
  getLatestEditedElements(): any[] | null;
  dispose(): void;
}

export function createEditorPersistence({
  app,
  context,
}: {
  app: App;
  context: WidgetContextController;
}): EditorPersistenceController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let initialSnapshot: string | null = null;
  let latestEditedElements: any[] | null = null;
  let storageKey: string | null = null;
  let initialElementsById: Map<string, any> = new Map();

  return {
    setStorageKey(key) {
      storageKey = `excalidraw:${key}`;
    },
    loadPersistedElements() {
      if (!storageKey) {
        return null;
      }

      const stored = safeLocalStorageGet(storageKey);
      if (!stored) {
        return null;
      }

      try {
        return JSON.parse(stored);
      } catch {
        return null;
      }
    },
    captureInitialElements(elements) {
      if (timer) {
        clearTimeout(timer);
      }
      initialSnapshot = buildSnapshot(elements);
      initialElementsById = new Map(elements.map((el: any) => [el.id, el]));
      latestEditedElements = null;
    },
    onEditorChange(elements) {
      const currentSnapshot = buildSnapshot(elements);
      if (currentSnapshot === initialSnapshot) {
        return;
      }

      const live = [...elements].filter((el: any) => !el.isDeleted);
      latestEditedElements = live;

      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        if (storageKey) {
          safeLocalStorageSet(storageKey, JSON.stringify(live));
        }
        if (context.getState().checkpointId) {
          app.callServerTool({
            name: "save_checkpoint",
            arguments: {
              id: context.getState().checkpointId,
              data: JSON.stringify({ elements: live }),
            },
          }).catch(() => {});
        }

        const diff = computeDiff(live, initialElementsById, context.getState().checkpointId);
        context.recordEdit(diff || null);
        flushModelContext(app, context);
      }, DEBOUNCE_MS);
    },
    getLatestEditedElements() {
      return latestEditedElements;
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
