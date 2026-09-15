import assert from "node:assert/strict";
import test from "node:test";
import { parseSceneData, type SceneData } from "../src/scene.js";
import type { SaveResult } from "../src/edit-context.js";
import { acknowledgement, deferred, widgetHarness } from "./helpers/widget-harness.js";

const scene = (id: string, color = "#000000") => parseSceneData({
  elements: [{ id, type: "rectangle", x: 0, y: 0, width: 120, height: 80, strokeColor: color }],
});
const a = scene("A"), b = scene("B"), editedA = scene("A", "#ff0000");
const input = (value: SceneData) => ({ type: "input" as const, value: { arguments: { scene: JSON.stringify(value) } } });
const result = (id: string) => ({
  type: "result" as const,
  value: { content: [], structuredContent: { checkpointId: id, revision: 1 } },
});

async function loadA(h: ReturnType<typeof widgetHarness>) {
  await h.emit(input(a));
  assert.equal(h.editor(), undefined, "A is only a preview before its result");
  await h.emit(result("cpA"));
  assert.equal(h.editor()?.props.initialData.elements[0].id, "A", "The real event/effect fixture reaches editable A");
  assert.match(h.text(), /Saved · revision 1/);
}

test("rejected replacement input/result preserves edits without localStorage until debounce saves A", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = widgetHarness({ checkpoints: { cpA: a, cpB: b }, storageDenied: true });
  t.after(() => h.dispose());
  await loadA(h);
  await h.edit(editedA);
  assert.match(h.text(), /Unsaved changes/);
  assert.match(h.text(), /Local recovery storage is unavailable/);
  await h.emit(input(b));
  await h.emit(result("cpB"));
  assert.ok(h.editor(), "Rejected input/result cannot hide the user's editor");
  assert.match(h.text(), /Unsaved changes/);
  assert.equal(h.calls.filter((call) => call.name === "save_checkpoint").length, 0);
  assert.equal(h.button("Download").disabled, false);
  h.button("Download").onClick();
  assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].strokeColor, "#ff0000");
  t.mock.timers.tick(1000);
  await h.settle();
  const saves = h.calls.filter((call) => call.name === "save_checkpoint");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].arguments.id, "cpA");
  assert.equal(JSON.parse(saves[0].arguments.data).elements[0].strokeColor, "#ff0000");
  assert.match(h.text(), /Saved · revision 2/);
  await h.emit(result("cpB"));
  assert.equal(h.editor()?.props.initialData.elements[0].id, "A", "A late result from the refused invocation stays refused after saving");
  t.mock.timers.tick(1500);
  await h.settle();
  assert.equal(h.contexts.length, 1);
  assert.match(h.contexts[0].content[0].text ?? "", /checkpoint cpA, saved revision 2.*Changed rectangle A/);
});

test("replacement result cannot detach an in-flight A save or hide its recovery controls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<SaveResult>();
  const h = widgetHarness({ checkpoints: { cpA: a, cpB: b }, storageDenied: true, save: () => pending.promise });
  t.after(() => h.dispose());
  await loadA(h);
  await h.edit(editedA);
  t.mock.timers.tick(1000);
  await h.settle();
  assert.match(h.text(), /Saving/);
  await h.emit(input(b));
  await h.emit(result("cpB"));
  assert.ok(h.editor());
  assert.match(h.text(), /Saving/);
  assert.equal(h.button("Download").disabled, false);
  pending.resolve({ isError: true, content: [{ type: "text", text: "Storage refused the save" }] });
  await h.settle();
  assert.match(h.text(), /Save failed/);
  assert.ok(h.button("Retry save").onClick);
  h.button("Download unsaved edits").onClick();
  assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].strokeColor, "#ff0000");
  assert.deepEqual(h.calls.filter((call) => call.name === "save_checkpoint").map((call) => call.arguments.id), ["cpA"]);
});

test("distinct partial and final B input never inherits A's checkpoint or editor readiness", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = widgetHarness({ checkpoints: { cpA: a, cpB: b } });
  t.after(() => h.dispose());
  await loadA(h);
  const reads = h.calls.filter((call) => call.name === "read_checkpoint").length;
  await h.emit({ type: "partial", value: { arguments: { elements: `${JSON.stringify(b.elements).slice(0, -1)},` } } });
  assert.equal(h.preview()?.elements[0].id, "B");
  assert.equal(h.editor(), undefined);
  assert.doesNotMatch(h.text(), /Saved · revision 1/);
  await h.emit(input(b));
  assert.equal(h.preview()?.elements[0].id, "B", "Final input must remain B while its authoritative result is pending");
  assert.equal(h.editor(), undefined);
  assert.match(h.text(), /Waiting for checkpoint acknowledgement/);
  assert.equal(h.calls.filter((call) => call.name === "read_checkpoint").length, reads, "B must not reread the previous invocation's checkpoint");
  await h.emit(result("cpB"));
  assert.equal(h.editor()?.props.initialData.elements[0].id, "B");
});

for (const replacement of ["input", "result"] as const) {
  test(`accepted B ${replacement} invalidates pending A feedback while B's read is delayed`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pendingB = deferred<SaveResult>();
    const h = widgetHarness({
      checkpoints: { cpA: a, cpB: b },
      read: async (id) => id === "cpB" ? pendingB.promise : { content: [], structuredContent: { ...a, revision: 2 } },
    });
    t.after(() => h.dispose());
    await h.emit(input(a));
    await h.emit(result("cpA"));
    assert.equal(h.editor()?.props.initialData.elements[0].id, "A");
    assert.match(h.text(), /Saved · revision 2/);
    if (replacement === "input") await h.emit(input(b));
    else await h.emit(result("cpB"));
    t.mock.timers.tick(1600);
    await h.settle();
    const feedback = h.contexts.flatMap((value) => value.content).map((value) => value.text ?? "").join("\n");
    assert.doesNotMatch(feedback, /checkpoint cpB, saved revision 2/, "An A save must never be relabeled as B");
    assert.equal(h.contexts.length, 0, "Accepted replacement invalidates A feedback immediately, not after its authoritative read");
    if (replacement === "input") await h.emit(result("cpB"));
    pendingB.resolve({ content: [], structuredContent: { ...b, revision: 1 } });
    await h.settle();
    t.mock.timers.tick(1500);
    await h.settle();
    assert.equal(h.contexts.length, 1);
    assert.match(h.contexts[0].content[0].text ?? "", /checkpoint cpB, saved revision 1/);
  });
}

test("explicit reload cannot discard edits made after the click when localStorage is denied", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reload = deferred<SaveResult>();
  let reads = 0, saves = 0;
  const h = widgetHarness({
    checkpoints: { cpA: a }, storageDenied: true,
    read: async () => ++reads === 1 ? { content: [], structuredContent: { ...a, revision: 1 } } : reload.promise,
    save: async (call) => ++saves === 1
      ? { isError: true, content: [{ type: "text", text: "Storage refused the save" }] }
      : acknowledgement(call.arguments.id, call.arguments.expectedRevision + 1),
  });
  t.after(() => h.dispose());
  await loadA(h);
  await h.edit(editedA);
  t.mock.timers.tick(1000);
  await h.settle();
  assert.match(h.text(), /Save failed/);
  h.button("Reload server copy").onClick();
  await h.settle();
  assert.equal(reads, 2, "The explicit reload is waiting for its authoritative response");
  await h.edit(scene("A", "#00ff00"));
  reload.resolve({ content: [], structuredContent: { ...a, revision: 1 } });
  await h.settle();
  assert.ok(h.editor(), "Late reload cannot remove the editor holding newer edits");
  assert.equal(h.button("Download").disabled, false);
  h.button("Download").onClick();
  assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].strokeColor, "#00ff00");
  h.button("Retry save").onClick();
  await h.settle();
  const submitted = h.calls.filter((call) => call.name === "save_checkpoint");
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].arguments.id, "cpA");
  assert.equal(JSON.parse(submitted[1].arguments.data).elements[0].strokeColor, "#00ff00");
  assert.match(h.text(), /Saved · revision 2/);
});

for (const type of ["cancelled", "error"] as const) {
  test(`refused B ${type} leaves A editable and fullscreen exit usable before and after save acknowledgement`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = widgetHarness({ checkpoints: { cpA: a, cpB: b }, storageDenied: true });
    t.after(() => h.dispose());
    await loadA(h);
    await h.edit(editedA);
    await h.emit(input(b));
    await h.emit({ type, value: "B generation failed" });
    assert.ok(h.editor(), "A terminal notification for refused B must not hide A");
    assert.equal(h.button("Exit fullscreen").disabled, false);
    t.mock.timers.tick(1000);
    await h.settle();
    assert.match(h.text(), /Saved · revision 2/);
    await h.emit({ type, value: "Late B generation failed" });
    assert.ok(h.editor(), "Acknowledging A must not allow late B terminal events to take over");
    assert.equal(h.button("Exit fullscreen").disabled, false);
    h.button("Download").onClick();
    assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].strokeColor, "#ff0000");
    h.button("Exit fullscreen").onClick();
    await h.settle();
    assert.equal(h.editor(), undefined);
    assert.equal(h.preview()?.elements[0].strokeColor, "#ff0000");
    assert.equal(h.button("Edit").disabled, false, "Exit completes rather than trapping the user in fullscreen");
  });
}

test("accepted partial B downloads its own preview instead of the pristine A editor tuple", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = widgetHarness({ checkpoints: { cpA: a, cpB: b } });
  t.after(() => h.dispose());
  await loadA(h);
  await h.edit(a);
  assert.match(h.text(), /Saved · revision 1/, "A's ordinary onChange is not a user edit");
  await h.emit({ type: "partial", value: { arguments: { elements: `${JSON.stringify(b.elements).slice(0, -1)},` } } });
  assert.equal(h.preview()?.elements[0].id, "B");
  assert.equal(h.editor(), undefined);
  assert.equal(h.button("Download").disabled, false);
  h.button("Download").onClick();
  assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].id, "B");
  assert.equal(h.calls.filter((call) => call.name === "save_checkpoint").length, 0);
});

test("buffered final input survives Strict Mode effect replay before asynchronous conversion completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fonts = deferred<void>();
  const h = widgetHarness({ checkpoints: { cpA: a }, initialEvents: [input(a)], loadFonts: () => fonts.promise });
  t.after(() => h.dispose());
  assert.equal(h.preview(), null, "Conversion is still awaiting fonts when Strict Mode replays effects");
  h.replayEffects();
  fonts.resolve();
  await h.settle();
  assert.equal(h.preview()?.elements[0].id, "A");
  assert.equal(h.editor(), undefined, "Final input alone is not a checkpoint acknowledgement");
  assert.match(h.text(), /Waiting for checkpoint acknowledgement/);
  assert.equal(h.button("Download").disabled, false);
  h.button("Download").onClick();
  assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].id, "A");
  assert.equal(h.calls.length, 0, "Replay must not invent a checkpoint read or save");
});

test("automatic checkpoint reads recheck edits arriving from a queued editor callback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reload = deferred<SaveResult>();
  let reads = 0;
  const h = widgetHarness({
    checkpoints: { cpA: a }, storageDenied: true,
    read: async () => ++reads === 1 ? { content: [], structuredContent: { ...a, revision: 1 } } : reload.promise,
  });
  t.after(() => h.dispose());
  await loadA(h);
  const onChange = h.editor()!.props.onChange;
  await h.emit(result("cpA"));
  assert.equal(reads, 2);
  // Editing can continue while an authoritative read is pending.
  onChange(editedA.elements, { ...editedA.appState, width: 0, height: 0 }, editedA.files);
  await h.settle();
  reload.resolve({ content: [], structuredContent: { ...a, revision: 1 } });
  await h.settle();
  assert.ok(h.editor(), "Refusing the stale read must keep the protected editor usable");
  assert.equal(h.button("Exit fullscreen").disabled, false);
  assert.equal(h.button("Download").disabled, false);
  h.button("Download").onClick();
  assert.equal(JSON.parse(await h.downloads[0].text()).elements[0].strokeColor, "#ff0000");
  t.mock.timers.tick(1000);
  await h.settle();
  const submitted = h.calls.filter((call) => call.name === "save_checkpoint");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].arguments.id, "cpA");
  assert.equal(JSON.parse(submitted[0].arguments.data).elements[0].strokeColor, "#ff0000");
});
