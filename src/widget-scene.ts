import { convertToExcalidrawElements, FONT_FAMILY, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { parseSceneData, type SceneData } from "./scene.js";

const restoredScenes = new WeakMap<SceneData, ReturnType<typeof restore>>();

function restoredScene(scene: SceneData) {
  let restored = restoredScenes.get(scene);
  if (!restored) {
    // Excalidraw's import signature requires native brands even for validated JSON.
    restored = restore({
      elements: scene.elements as unknown as ExcalidrawElement[],
      appState: nativeAppState(scene), files: scene.files as unknown as BinaryFiles,
    }, null, null, { repairBindings: true });
    restoredScenes.set(scene, restored);
  }
  return restored;
}

export async function loadSceneFonts(scene: SceneData) {
  const families = new Set<string>(["Excalifont"]);
  for (const element of scene.elements) {
    const entry = Object.entries(FONT_FAMILY).find(([, value]) => value === element.fontFamily);
    if (entry) families.add(entry[0]);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([...families].map((family) => document.fonts.load(`20px "${family}"`))),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Font loading timed out.")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Skeleton conversion is browser-only. Native elements use restoration, never font overrides. */
export function toNativeScene(scene: SceneData): SceneData {
  const isNative = (element: SceneData["elements"][number]) => typeof element.version === "number" && !element.label && !element.start && !element.end;
  const nativeIds = new Set(scene.elements.filter(isNative).map((element) => element.id));
  const skeletons = scene.elements.filter((element) => !isNative(element)).map((element) => ({
    ...element,
    ...(element.type === "text" && element.fontFamily === undefined ? { fontFamily: FONT_FAMILY.Excalifont } : {}),
    ...(element.label && typeof element.label === "object" ? {
      label: { fontFamily: FONT_FAMILY.Excalifont, textAlign: "center", verticalAlign: "middle", ...element.label },
    } : {}),
  }));
  // Only referenced native shapes need stubs; the native objects themselves are never converted.
  const referenceIds = new Set(skeletons.flatMap((element) => [element.start?.id, element.end?.id]).filter(Boolean));
  const references = scene.elements.filter((element) => nativeIds.has(element.id) && referenceIds.has(element.id))
    .map(({ id, type, x, y, width, height, text, fileId }) => ({ id, type, x, y, width, height, text, fileId }));
  const conversion = skeletons.length ? convertToExcalidrawElements(
    [...references, ...skeletons] as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false },
  ) : [];
  const converted = conversion.filter((element) => !nativeIds.has(element.id));
  const originals = new Set(scene.elements.map((element) => element.id));
  const generatedIds = new Map<string, string>();
  const usedIds = new Set(originals);
  for (const element of converted) {
    if (originals.has(element.id) || element.type !== "text" || !element.containerId) continue;
    let id = `mcp-label:${element.containerId}`;
    while (usedIds.has(id)) id += "_";
    usedIds.add(id);
    generatedIds.set(element.id, id);
  }
  const stableConverted = converted.map((element) => ({
    ...element,
    id: generatedIds.get(element.id) ?? element.id,
    boundElements: element.boundElements?.map((bound) => ({ ...bound, id: generatedIds.get(bound.id) ?? bound.id })) ?? null,
  }));
  const combined: Array<{ id: string }> = scene.elements.flatMap<{ id: string }>((element) => {
    if (nativeIds.has(element.id)) {
      const addedBindings = conversion.find((reference) => reference.id === element.id)?.boundElements ?? [];
      const boundElements = [...new Map([...(element.boundElements ?? []), ...addedBindings].map((binding) => [binding.id, binding])).values()];
      return [{ ...element, boundElements: boundElements.length ? boundElements : null }];
    }
    return stableConverted.filter((convertedElement) => convertedElement.id === element.id ||
      ("containerId" in convertedElement && convertedElement.containerId === element.id));
  });
  for (const element of stableConverted) if (!combined.some((existing) => existing.id === element.id)) combined.push(element);
  // Restore converter defaults before strict validation (versionless freehand needs version normalization).
  const normalized = restore({
    elements: combined as unknown as ExcalidrawElement[],
    appState: nativeAppState(scene), files: scene.files as unknown as BinaryFiles,
  }, null, null, { repairBindings: true });
  const reconciled = parseSceneData({ ...scene, ...normalized });
  const sourceById = new Map(scene.elements.map((element) => [element.id, element]));
  const byId = new Map(reconciled.elements.map((element) => [element.id, element]));
  for (const element of reconciled.elements) {
    const source = sourceById.get(element.id);
    if (element.type !== "arrow" || !source || nativeIds.has(element.id)) continue;
    // Skeleton conversion drops native-style bindings. Explicit bindings take precedence over shorthand.
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = source[key];
      if (binding !== undefined) {
        element[key] = binding ? { ...binding, focus: binding.focus ?? 0, gap: binding.gap ?? 0 } : null;
      }
    }
  }
  for (const element of reconciled.elements) {
    if (element.boundElements) {
      element.boundElements = element.boundElements.filter((binding) => {
        if (binding.type !== "arrow") return true;
        const arrow = byId.get(binding.id);
        return arrow?.startBinding?.elementId === element.id || arrow?.endBinding?.elementId === element.id;
      });
    }
  }
  for (const element of reconciled.elements) {
    if (element.type !== "arrow") continue;
    for (const binding of [element.startBinding, element.endBinding]) {
      const target = binding && byId.get(binding.elementId);
      if (target && !target.boundElements?.some((bound) => bound.id === element.id)) {
        target.boundElements = [...target.boundElements ?? [], { id: element.id, type: "arrow" }];
      }
    }
  }
  const restored = restore({
    elements: reconciled.elements as unknown as ExcalidrawElement[],
    appState: nativeAppState(scene), files: scene.files as unknown as BinaryFiles,
  }, null, null, { repairBindings: true });
  const result = parseSceneData({ ...scene, ...restored });
  restoredScenes.set(result, restored);
  return result;
}

export function nativeElements(scene: SceneData) {
  return restoredScene(scene).elements.filter((element): element is typeof element & { isDeleted: false } => !element.isDeleted);
}

export function nativeFiles(scene: SceneData) {
  return restoredScene(scene).files;
}

export function nativeAppState(scene: SceneData): Partial<AppState> {
  const { gridSize, ...appState } = scene.appState;
  return { ...appState, ...(gridSize === null ? { gridModeEnabled: false } : { gridSize }) };
}

export function serializeScene(scene: SceneData) {
  return serializeAsJSON(nativeElements(scene), nativeAppState(scene), nativeFiles(scene), "local");
}
