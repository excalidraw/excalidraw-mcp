import { describe, it, expect, vi, beforeEach } from "vitest";
import { onSelectionChange } from "./edit-context.js";

function makeApp() {
  return { updateModelContext: vi.fn().mockResolvedValue(undefined) } as any;
}

describe("onSelectionChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends identity summary for a single selected rectangle with label", async () => {
    const app = makeApp();
    const elements = [
      { id: "r1", type: "rectangle", label: { text: "Database" } },
      { id: "e1", type: "ellipse", label: { text: "Cache" } },
    ];
    onSelectionChange(app, { r1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: "text", text: "Selected: rectangle 'Database' (r1)" }],
    });
  });

  it("sends identity summary for multiple selected elements", async () => {
    const app = makeApp();
    const elements = [
      { id: "r1", type: "rectangle", label: { text: "Database" } },
      { id: "a1", type: "arrow", text: "writes to" },
    ];
    onSelectionChange(app, { r1: true, a1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: "text", text: "Selected: rectangle 'Database' (r1), arrow 'writes to' (a1)" }],
    });
  });

  it("omits label when element has no text", async () => {
    const app = makeApp();
    const elements = [{ id: "r1", type: "rectangle" }];
    onSelectionChange(app, { r1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({
      content: [{ type: "text", text: "Selected: rectangle (r1)" }],
    });
  });

  it("clears context when no elements are selected", async () => {
    const app = makeApp();
    const elements = [{ id: "r1", type: "rectangle", label: { text: "DB" } }];
    onSelectionChange(app, {}, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledWith({ content: [] });
  });

  it("debounces — only fires once for rapid calls", async () => {
    const app = makeApp();
    const elements = [{ id: "r1", type: "rectangle", label: { text: "DB" } }];
    onSelectionChange(app, { r1: true }, elements);
    onSelectionChange(app, { r1: true }, elements);
    onSelectionChange(app, { r1: true }, elements);
    vi.runAllTimers();
    await Promise.resolve();
    expect(app.updateModelContext).toHaveBeenCalledTimes(1);
  });
});
