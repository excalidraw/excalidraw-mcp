import { getCommonBounds, sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";

export interface CommentAnchor {
  left: number;
  top: number;
}

export function getSelectionAnchor(
  api: any,
  selectedIds: Record<string, boolean>,
  allElements: readonly any[],
): CommentAnchor | null {
  const selected = allElements.filter(
    (el: any) => selectedIds[el.id] && !el.isDeleted && !el.containerId,
  );
  if (selected.length === 0) {
    return null;
  }

  const [minX, minY, maxX] = getCommonBounds(selected as any);
  const appState = api?.getAppState?.();
  if (!appState) {
    return null;
  }

  const centerX = minX + (maxX - minX) / 2;
  const viewportPoint = sceneCoordsToViewportCoords(
    { sceneX: centerX, sceneY: minY },
    appState,
  );
  return { left: viewportPoint.x, top: viewportPoint.y };
}

export function anchorsEqual(a: CommentAnchor | null, b: CommentAnchor | null) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5;
}
