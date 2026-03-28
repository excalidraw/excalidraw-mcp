import type { WidgetContextElement } from "./widget-context";

export function buildSelectionSummaryFromCount(count: number) {
  if (count <= 0) {
    return null;
  }
  return count === 1 ? "Selected 1 element." : `Selected ${count} elements.`;
}

export function buildSelectionDetails(
  selectedIds: Record<string, boolean>,
  allElements: readonly any[],
): WidgetContextElement[] {
  const selected = allElements.filter((el: any) => selectedIds[el.id]);
  if (selected.length === 0) {
    return [];
  }

  return selected
    .filter((el: any) => !el.containerId)
    .map((el: any) => {
      const label = el.label?.text
        ?? el.text
        ?? allElements.find((t: any) => t.containerId === el.id && t.type === "text")?.text
        ?? "";
      return {
        id: el.id,
        type: el.type,
        ...(label ? { label } : {}),
      };
    });
}

export function buildSelectionSummary(
  selectedIds: Record<string, boolean>,
  allElements: readonly any[],
) {
  return buildSelectionSummaryFromCount(
    buildSelectionDetails(selectedIds, allElements).length,
  );
}
