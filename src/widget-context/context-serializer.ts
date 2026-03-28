import type { App } from "@modelcontextprotocol/ext-apps";
import type { WidgetContextState } from "./context-store";

type ModelContextPayload = Parameters<App["updateModelContext"]>[0];

function compactEditSummary(summary: string) {
  if (summary.length <= 120) {
    return summary;
  }
  return `${summary.slice(0, 117)}...`;
}

function describeElement(element: { type: string; label?: string; id: string }) {
  if (element.label) {
    return `${element.type} "${element.label}"`;
  }
  return `${element.type} (${element.id})`;
}

function describeSelection(
  elements: Array<{ type: string; label?: string; id: string }>,
) {
  if (elements.length === 0) {
    return null;
  }

  const described = elements.slice(0, 5).map(describeElement);
  const lines = ["Elements:"];
  for (const element of described) {
    lines.push(`- ${element}`);
  }
  if (elements.length > 5) {
    lines.push(`- +${elements.length - 5} more`);
  }
  return lines.join("\n");
}

function describeRecentComments(
  comments: Array<{ text: string }>,
) {
  if (comments.length === 0) {
    return null;
  }

  const lines = ["Recent comments:"];
  for (const comment of comments.slice(-3)) {
    lines.push(`- "${comment.text}"`);
  }
  return lines.join("\n");
}

function describeRecentEdits(
  edits: Array<{ summary: string }>,
) {
  if (edits.length === 0) {
    return null;
  }

  const lines = ["Recent edits:"];
  for (const edit of edits.slice(-3)) {
    lines.push(`- ${compactEditSummary(edit.summary)}`);
  }
  return lines.join("\n");
}

export function serializeWidgetContext(state: WidgetContextState): ModelContextPayload {
  const contentParts: string[] = [];

  if (state.selection?.elements.length) {
    contentParts.push(
      state.selection.elements.length === 1
        ? "Selected 1 element."
        : `Selected ${state.selection.elements.length} elements.`,
    );
    const selectionDetails = describeSelection(state.selection.elements);
    if (selectionDetails) {
      contentParts.push(selectionDetails);
    }
  }

  if (state.comments.length > 0) {
    const commentsBlock = describeRecentComments(state.comments);
    if (commentsBlock) {
      contentParts.push(commentsBlock);
    }
  }

  if (state.latestEditSummary) {
    const editsBlock = describeRecentEdits(state.edits);
    if (editsBlock) {
      contentParts.push(editsBlock);
    } else {
      contentParts.push(`Recent edits:\n- ${compactEditSummary(state.latestEditSummary)}`);
    }
  }

  const structuredContent: Record<string, unknown> = {};

  if (state.checkpointId) {
    structuredContent.checkpointId = state.checkpointId;
  }
  if (state.selection?.elements.length) {
    structuredContent.selection = state.selection;
  }
  if (state.edits.length > 0) {
    structuredContent.edits = state.edits;
  }
  if (state.comments.length > 0) {
    structuredContent.comments = state.comments;
  }
  if (state.lastAction) {
    structuredContent.lastAction = state.lastAction;
  }

  if (contentParts.length === 0 && Object.keys(structuredContent).length === 0) {
    return { content: [] };
  }

  return {
    content: contentParts.length > 0 ? [{ type: "text", text: contentParts.join("\n\n") }] : [],
    ...(Object.keys(structuredContent).length > 0 ? { structuredContent } : {}),
  };
}
