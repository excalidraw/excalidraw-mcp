import { FONT_FAMILY, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ViewportRect } from "./viewport-utils";

export function parsePartialElements(str: string | undefined): any[] {
  if (!str?.trim().startsWith("[")) {
    return [];
  }
  try {
    return JSON.parse(str);
  } catch {}

  const last = str.lastIndexOf("}");
  if (last < 0) {
    return [];
  }

  try {
    return JSON.parse(`${str.substring(0, last + 1)}]`);
  } catch {
    return [];
  }
}

export function excludeIncompleteLastItem<T>(arr: T[]): T[] {
  if (arr.length <= 1) {
    return [];
  }
  return arr.slice(0, -1);
}

export function convertRawElements(els: any[]): any[] {
  const pseudoTypes = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);
  const pseudos = els.filter((el: any) => pseudoTypes.has(el.type));
  const real = els.filter((el: any) => !pseudoTypes.has(el.type));
  const withDefaults = real.map((el: any) =>
    el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el,
  );
  const converted = convertToExcalidrawElements(withDefaults, { regenerateIds: false })
    .map((el: any) => (
      el.type === "text"
        ? { ...el, fontFamily: (FONT_FAMILY as any).Excalifont ?? 1 }
        : el
    ));
  return [...converted, ...pseudos];
}

export function fixViewBox4x3(svg: SVGSVGElement): void {
  const vb = svg.getAttribute("viewBox")?.split(" ").map(Number);
  if (!vb || vb.length !== 4) {
    return;
  }

  const [vx, vy, vw, vh] = vb;
  const ratio = vw / vh;
  if (Math.abs(ratio - 4 / 3) < 0.01) {
    return;
  }

  if (ratio > 4 / 3) {
    const h2 = Math.round(vw * 3 / 4);
    svg.setAttribute("viewBox", `${vx} ${vy - Math.round((h2 - vh) / 2)} ${vw} ${h2}`);
    return;
  }

  const w2 = Math.round(vh * 4 / 3);
  svg.setAttribute("viewBox", `${vx - Math.round((w2 - vw) / 2)} ${vy} ${w2} ${vh}`);
}

export function extractViewportAndElements(elements: any[]): {
  viewport: ViewportRect | null;
  drawElements: any[];
  restoreId: string | null;
  deleteIds: Set<string>;
} {
  let viewport: ViewportRect | null = null;
  let restoreId: string | null = null;
  const deleteIds = new Set<string>();
  const drawElements: any[] = [];

  for (const el of elements) {
    if (el.type === "cameraUpdate") {
      viewport = { x: el.x, y: el.y, width: el.width, height: el.height };
    } else if (el.type === "restoreCheckpoint") {
      restoreId = el.id;
    } else if (el.type === "delete") {
      for (const id of String(el.ids ?? el.id).split(",")) {
        deleteIds.add(id.trim());
      }
    } else {
      drawElements.push(el);
    }
  }

  const processedDraw = deleteIds.size > 0
    ? drawElements.map((el: any) => (
      deleteIds.has(el.id) || deleteIds.has(el.containerId)
        ? { ...el, opacity: 1 }
        : el
    ))
    : drawElements;

  return { viewport, drawElements: processedDraw, restoreId, deleteIds };
}

export function getToolInputElementsSignature(toolInput: any): string | null {
  const raw = toolInput?.elements;
  if (!raw) {
    return null;
  }
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}
