export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeZoom(value: number) {
  return Math.max(0.1, Math.min(30, value));
}

function centerScrollOnScenePoint({
  scenePoint,
  viewportDimensions,
  zoomValue,
  offsets,
}: {
  scenePoint: { x: number; y: number };
  viewportDimensions: { width: number; height: number };
  zoomValue: number;
  offsets?: { left?: number; top?: number; right?: number; bottom?: number };
}) {
  let scrollX = (viewportDimensions.width - (offsets?.right ?? 0)) / 2 / zoomValue - scenePoint.x;
  scrollX += (offsets?.left ?? 0) / 2 / zoomValue;

  let scrollY = (viewportDimensions.height - (offsets?.bottom ?? 0)) / 2 / zoomValue - scenePoint.y;
  scrollY += (offsets?.top ?? 0) / 2 / zoomValue;

  return { scrollX, scrollY };
}

export function getViewportAppState(api: any, viewport: ViewportRect) {
  const appState = api?.getAppState?.();
  if (!appState || !viewport.width || !viewport.height) {
    return null;
  }

  const zoomValue = normalizeZoom(
    Math.min(appState.width / viewport.width, appState.height / viewport.height),
  );
  const { scrollX, scrollY } = centerScrollOnScenePoint({
    scenePoint: {
      x: viewport.x + viewport.width / 2,
      y: viewport.y + viewport.height / 2,
    },
    viewportDimensions: {
      width: appState.width,
      height: appState.height,
    },
    zoomValue,
    offsets: {
      left: appState.offsetLeft ?? 0,
      top: appState.offsetTop ?? 0,
      right: appState.offsetRight ?? 0,
      bottom: appState.offsetBottom ?? 0,
    },
  });

  return {
    scrollX,
    scrollY,
    zoom: { value: zoomValue },
  };
}
