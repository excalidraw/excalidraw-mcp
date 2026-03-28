import { describe, expect, it } from "vitest";
import { buildSelectionDetails, buildSelectionSummary } from "./selection-utils";

describe("selection utils", () => {
  it("resolves labels from bound text and ignores the bound text node itself", () => {
    const elements = [
      { id: "r1", type: "rectangle" },
      { id: "t1", type: "text", containerId: "r1", text: "Client App" },
      { id: "a1", type: "arrow", text: "request" },
    ];

    expect(buildSelectionDetails({ r1: true, t1: true, a1: true }, elements)).toEqual([
      { id: "r1", type: "rectangle", label: "Client App" },
      { id: "a1", type: "arrow", label: "request" },
    ]);
  });

  it("returns null summary when only bound text is selected", () => {
    const elements = [
      { id: "r1", type: "rectangle" },
      { id: "t1", type: "text", containerId: "r1", text: "label" },
    ];

    expect(buildSelectionSummary({ t1: true }, elements)).toBeNull();
  });
});
