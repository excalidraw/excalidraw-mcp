import assert from "node:assert/strict";
import test from "node:test";
import { createEditController, summarizeSceneChanges, type SaveResult } from "../src/edit-context.js";
import { createAppEventBuffer, type WidgetEvent } from "../src/app-events.js";
import { createMockApp } from "../src/dev-mock.js";
import { parseSceneData, type Checkpoint, type SceneData } from "../src/scene.js";
import type { App } from "@modelcontextprotocol/ext-apps";
import { hasLiveImages } from "../src/sharing.js";

const initial = (): SceneData => parseSceneData({
  schemaVersion: 1,
  elements: [{ id: "text", type: "text", x: 0, y: 0, width: 100, height: 20, text: "Before", fontFamily: 3 }],
  files: {}, appState: { viewBackgroundColor: "#ffffff" },
});
const edited = (): SceneData => ({ ...initial(), elements: [{ ...initial().elements[0], text: "After", strokeColor: "#ff0000" }] });
const ack = (checkpointId: string, revision: number): SaveResult => ({ structuredContent: { checkpointId, revision }, content: [] });
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("image sharing is restricted only for live image elements", () => {
  assert.equal(hasLiveImages([]), false);
  assert.equal(hasLiveImages([{ type: "rectangle" }, { type: "text" }]), false);
  assert.equal(hasLiveImages([{ type: "image", isDeleted: true }]), false);
  assert.equal(hasLiveImages([{ type: "image" }]), true);
  assert.equal(hasLiveImages([{ type: "image", isDeleted: false }, { type: "rectangle" }]), true);
});

test("mock sharing keeps shape-only links but rejects images before uploading", async () => {
  const mock = createMockApp();
  const shapeOnly = await mock.app.callServerTool({ name: "export_to_excalidraw", arguments: { json: JSON.stringify(initial()) } });
  assert.notEqual(shapeOnly.isError, true);
  const image = initial();
  image.elements.push({ id: "image", type: "image", x: 0, y: 0, width: 50, height: 50, fileId: "file" });
  image.files.file = { id: "file", mimeType: "image/png", dataURL: "data:image/png;base64,YQ==", created: 1 };
  const blocked = await mock.app.callServerTool({ name: "export_to_excalidraw", arguments: { json: JSON.stringify(image) } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].type === "text" ? blocked.content[0].text : "", /Download the \.excalidraw file to preserve images/);
});

test("save acknowledgement advances the revision and includes text/style feedback", async () => {
  const cache = storage();
  const summaries: string[] = [];
  const calls: { id: string; data: string; expectedRevision: number }[] = [];
  const controller = createEditController({
    storage: cache,
    save: async (args) => { calls.push(args); return ack(args.id, args.expectedRevision + 1); },
    onSaved: (_scene, _revision, summary) => summaries.push(summary),
  });
  controller.initialize("checkpoint", 4, initial());
  controller.change(edited());
  assert.equal(controller.getState().status, "dirty");
  await controller.flush();
  assert.equal(calls[0].expectedRevision, 4);
  assert.equal(controller.getState().revision, 5);
  assert.equal(controller.getState().status, "saved");
  assert.match(summaries[0], /Changed text text: After/);
  assert.equal(JSON.parse(cache.getItem("excalidraw:checkpoint")!).dirty, false);
  await controller.dispose();
});

test("legacy element-array caches are archived and offered as download-only recovery", async () => {
  const cache = storage();
  const raw = JSON.stringify(edited().elements);
  cache.setItem("excalidraw:checkpoint", raw);
  let saves = 0;
  const controller = createEditController({
    storage: cache,
    save: async (args) => { saves++; return ack(args.id, 5); },
  });
  controller.initialize("checkpoint", 4, initial());
  assert.equal(cache.getItem("excalidraw:checkpoint:legacy"), raw);
  assert.equal(controller.getState().recovery?.scene.elements[0].text, "After");
  assert.equal(controller.getState().recovery?.revision, -1);
  assert.match(controller.getState().recovery?.message ?? "", /unknown revision/);
  assert.equal(controller.restoreRecovery(), null);
  await controller.dispose();
  assert.equal(saves, 0);
});

test("invalid cached recovery revisions cannot crash rendering or overwrite the unread copy", async () => {
  const cache = storage();
  const raw = JSON.stringify({
    scene: initial(), revision: 4, dirty: false,
    recovery: { scene: edited(), revision: { invalid: true } },
  });
  cache.setItem("excalidraw:checkpoint", raw);
  const controller = createEditController({ storage: cache, save: async (args) => ack(args.id, 5) });
  controller.initialize("checkpoint", 4, initial());
  assert.equal(controller.getState().recovery, undefined);
  assert.match(controller.getState().error ?? "", /left untouched/);
  controller.change(edited());
  await controller.dispose();
  assert.equal(cache.getItem("excalidraw:checkpoint"), raw);
  assert.equal(controller.getState().revision, 5);
});

test("feedback observer failures stay visible without invalidating a durable save", async () => {
  const controller = createEditController({
    save: async (args) => ack(args.id, 2),
    onSaved: () => { throw new Error("Feedback failed"); },
  });
  controller.initialize("checkpoint", 1, initial());
  controller.change(edited());
  await controller.dispose();
  assert.equal(controller.getState().status, "saved");
  assert.equal(controller.getState().revision, 2);
  assert.match(controller.getState().error ?? "", /feedback could not be delivered/);
});

test("complete scene files, native font, background and viewport survive cache and saves", async () => {
  const data = initial();
  data.elements.push({ id: "image", type: "image", x: 5, y: 8, width: 50, height: 50, fileId: "file" });
  data.files.file = { id: "file", mimeType: "image/png", dataURL: "data:image/png;base64,YQ==", created: 1 };
  data.viewport = { x: 0, y: 0, width: 400, height: 300 };
  const cache = storage();
  let submitted: SceneData | undefined;
  const controller = createEditController({ storage: cache, save: async (args) => { submitted = parseSceneData(JSON.parse(args.data)); return ack(args.id, 2); } });
  controller.initialize("image-checkpoint", 1, initial());
  controller.change(data);
  await controller.dispose();
  assert.deepEqual(submitted, data);
  assert.deepEqual(JSON.parse(cache.getItem("excalidraw:image-checkpoint")!).scene, data);
});

test("acknowledged legacy revision zero saves a versioned scene and advances to one", async () => {
  const controller = createEditController({
    save: async (args) => {
      assert.equal(args.expectedRevision, 0);
      assert.equal(JSON.parse(args.data).schemaVersion, 1);
      return ack(args.id, 1);
    },
  });
  controller.initialize("legacy", 0, initial());
  controller.change(edited());
  await controller.flush();
  assert.equal(controller.getState().status, "saved");
  assert.equal(controller.getState().revision, 1);
  assert.equal(controller.hasChanges(), false);
  await controller.dispose();
});

test("isError and incomplete acknowledgements never appear saved", async () => {
  for (const response of [
    { isError: true, content: [{ type: "text", text: "Storage refused this save" }] },
    { content: [] },
    ack("another-checkpoint", 2),
  ] satisfies SaveResult[]) {
    let calls = 0;
    const controller = createEditController({ save: async () => { calls++; return response; } });
    controller.initialize("checkpoint", 1, initial());
    controller.change(edited());
    await controller.flush();
    await controller.flush();
    assert.equal(controller.getState().status, "error");
    assert.equal(controller.getState().revision, 1);
    assert.equal(controller.hasChanges(), true);
    assert.equal(calls, 1);
    await controller.dispose();
  }
});

test("non-Error save rejections preserve edits, leave saving, and allow explicit recovery", async (t) => {
  const reasons: { name: string; value: unknown }[] = [
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "string", value: "Storage offline" },
    { name: "empty string", value: "" },
    { name: "number", value: 42 },
    { name: "boolean", value: false },
    { name: "symbol", value: Symbol("save failure") },
    { name: "plain object", value: {} },
    { name: "null message", value: { message: null } },
    { name: "object message", value: { message: { detail: "offline" } } },
    { name: "invalid flags", value: { conflict: "yes", transient: "yes" } },
  ];
  for (const { name, value } of reasons) {
    await t.test(name, async () => {
      const cache = storage();
      let calls = 0;
      const controller = createEditController({
        storage: cache,
        retryDelays: [0, 0],
        save: async (args) => {
          calls++;
          if (calls === 1) throw value;
          return ack(args.id, args.expectedRevision + 1);
        },
      });
      controller.initialize("checkpoint", 4, initial());
      controller.change(edited());
      await assert.doesNotReject(controller.flush());
      assert.equal(controller.getState().status, "error");
      assert.equal(controller.getState().revision, 4);
      assert.equal(controller.hasChanges(), true);
      assert.equal(typeof controller.getState().error, "string");
      assert.ok(controller.getState().error?.trim());
      if (name === "string") assert.equal(controller.getState().error, "Storage offline");
      assert.equal(JSON.parse(cache.getItem("excalidraw:checkpoint")!).dirty, true);
      await controller.flush();
      assert.equal(calls, 1, "unknown rejection reasons must not trigger automatic retries");
      await controller.retry();
      assert.equal(calls, 2);
      assert.equal(controller.getState().status, "saved");
      assert.equal(controller.getState().revision, 5);
      assert.equal(controller.hasChanges(), false);
      await controller.dispose();
    });
  }
});

test("transient failures retry with a bound, permanent errors do not", async () => {
  let calls = 0;
  const controller = createEditController({
    retryDelays: [0, 0],
    save: async () => { calls++; throw new TypeError("Network unavailable"); },
  });
  controller.initialize("checkpoint", 1, initial());
  controller.change(edited());
  await controller.flush();
  assert.equal(calls, 3);
  assert.equal(controller.getState().status, "error");
  await controller.dispose();
});

test("revision conflicts are retained and never automatically or blindly retried", async () => {
  let calls = 0;
  const controller = createEditController({
    retryDelays: [0, 0],
    save: async () => {
      calls++;
      return { isError: true, structuredContent: { code: "revision_conflict", actualRevision: 8 }, content: [{ type: "text", text: "Revision conflict" }] };
    },
  });
  controller.initialize("checkpoint", 1, initial());
  controller.change(edited());
  await controller.flush();
  await controller.retry();
  assert.equal(calls, 1);
  assert.equal(controller.getState().status, "conflict");
  assert.equal(controller.getScene()!.elements[0].text, "After");
  await controller.dispose();
});

test("edits arriving during save are saved serially with the acknowledged revision", async () => {
  const first = deferred<SaveResult>();
  const revisions: number[] = [];
  const controller = createEditController({
    save: async (args) => { revisions.push(args.expectedRevision); return revisions.length === 1 ? first.promise : ack("checkpoint", args.expectedRevision + 1); },
  });
  controller.initialize("checkpoint", 1, initial());
  controller.change(edited());
  const saving = controller.flush();
  controller.change({ ...edited(), elements: [] });
  first.resolve(ack("checkpoint", 2));
  await saving;
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(controller.getState().revision, 3);
  assert.deepEqual(controller.getScene()!.elements, []);
  assert.equal(controller.getState().status, "saved");
  await controller.dispose();
});

test("save feedback receives the acknowledged checkpoint identity as a value", async () => {
  const snapshots: { id: string; revision: number; text: string | undefined }[] = [];
  const controller = createEditController({
    save: async (args) => ack(args.id, args.expectedRevision + 1),
    onSaved: (scene, revision, _summary, checkpointId) => {
      snapshots.push({ id: checkpointId, revision, text: scene.elements[0]?.text });
    },
  });
  controller.initialize("checkpoint-A", 1, initial());
  controller.change(edited());
  await controller.flush();
  controller.initialize("checkpoint-B", 7, initial());
  controller.change(edited());
  await controller.flush();
  assert.deepEqual(snapshots, [
    { id: "checkpoint-A", revision: 2, text: "After" },
    { id: "checkpoint-B", revision: 8, text: "After" },
  ]);
  await controller.dispose();
});

test("MCP error metadata identifies conflicts even when the error text is generic", async () => {
  let calls = 0;
  const controller = createEditController({
    retryDelays: [0, 0],
    save: async () => {
      calls++;
      return {
        isError: true,
        _meta: { code: "revision_conflict", currentRevision: 8, retryable: true },
        content: [{ type: "text", text: "The save was rejected. Reload the server copy." }],
      };
    },
  });
  controller.initialize("checkpoint", 1, initial());
  controller.change(edited());
  await controller.flush();
  await controller.retry();
  assert.equal(calls, 1);
  assert.equal(controller.getState().status, "conflict");
  assert.equal(controller.getState().revision, 1);
  await controller.dispose();
});

test("widget controllers and diagram generations cannot leak saved state", async () => {
  const pending = deferred<SaveResult>();
  const first = createEditController({ save: async () => pending.promise });
  const second = createEditController({ save: async () => ack("second", 10) });
  first.initialize("first", 1, initial());
  second.initialize("second", 9, initial());
  first.change(edited());
  const saving = first.flush();
  first.initialize("new-diagram", 20, initial());
  pending.resolve(ack("first", 2));
  await saving;
  assert.equal(first.getState().revision, 20);
  assert.equal(first.getScene()!.elements[0].text, "Before");
  assert.equal(second.getState().revision, 9);
  assert.equal(second.hasChanges(), false);
  await first.dispose(); await second.dispose();
});

test("dirty empty scenes remain recoverable without silently replacing the server", async () => {
  const cache = storage();
  const empty = { ...initial(), elements: [] };
  cache.setItem("excalidraw:checkpoint", JSON.stringify({ scene: empty, revision: 3, dirty: true }));
  const controller = createEditController({ storage: cache, save: async () => ack("checkpoint", 4) });
  controller.initialize("checkpoint", 3, initial());
  assert.equal(controller.getScene()!.elements.length, 1);
  assert.deepEqual(controller.getState().recovery?.scene.elements, []);
  assert.deepEqual(controller.restoreRecovery()?.elements, []);
  await controller.flush();
  assert.equal(controller.getState().status, "saved");
  await controller.dispose();
});

test("stale dirty cache is downloadable but cannot overwrite a newer server revision", async () => {
  const cache = storage();
  cache.setItem("excalidraw:checkpoint", JSON.stringify({ scene: edited(), revision: 2, dirty: true }));
  let calls = 0;
  const controller = createEditController({ storage: cache, save: async () => { calls++; return ack("checkpoint", 6); } });
  controller.initialize("checkpoint", 5, initial());
  assert.equal(controller.getState().recovery?.revision, 2);
  assert.equal(controller.restoreRecovery(), null);
  assert.equal(controller.getScene()!.elements[0].text, "Before");
  await controller.flush();
  assert.equal(calls, 0);
  assert.equal(JSON.parse(cache.getItem("excalidraw:checkpoint")!).recovery.scene.elements[0].text, "After");
  await controller.dispose();
});

test("clean stale cache never replaces the current server scene", async () => {
  const cache = storage();
  cache.setItem("excalidraw:checkpoint", JSON.stringify({ scene: edited(), revision: 1, dirty: false }));
  const controller = createEditController({ storage: cache, save: async () => ack("checkpoint", 6) });
  controller.initialize("checkpoint", 5, initial());
  assert.equal(controller.getScene()!.elements[0].text, "Before");
  assert.equal(controller.getState().recovery, undefined);
  await controller.dispose();
});

test("style-only changes without version increments are reported", () => {
  const after = initial();
  after.elements[0].strokeColor = "#abcdef";
  assert.match(summarizeSceneChanges(initial(), after), /Changed text/);
});

test("startup buffer retains final input, result, context and cancellation before mounting", () => {
  const buffer = createAppEventBuffer();
  const app = {} as App;
  buffer.register(app);
  app.ontoolinputpartial!({ arguments: { elements: "[" } });
  app.ontoolinputpartial!({ arguments: { elements: "[]" } });
  app.ontoolinput!({ arguments: { elements: "[]" } });
  app.ontoolresult!({ content: [], structuredContent: { checkpointId: "checkpoint", revision: 1, warnings: ["Legacy images are unavailable."] } });
  app.onhostcontextchanged!({ displayMode: "fullscreen" });
  app.ontoolcancelled!({ reason: "Cancelled" });
  const received: WidgetEvent[] = [];
  buffer.subscribe((event) => received.push(event), async () => {});
  assert.deepEqual(received.map((event) => event.type), ["input", "result", "context", "cancelled"]);
  assert.deepEqual(received.find((event) => event.type === "result")?.value.structuredContent?.warnings, ["Legacy images are unavailable."]);
  app.onhostcontextchanged!({ theme: "dark" });
  assert.equal(received.at(-1)?.type, "context");
});

test("effect resubscription replays terminal notifications instead of losing in-flight startup", () => {
  const buffer = createAppEventBuffer();
  buffer.publish({ type: "context", value: { availableDisplayModes: ["inline", "fullscreen"], theme: "light" } });
  buffer.publish({ type: "input", value: { elements: "[]" } });
  const unsubscribe = buffer.subscribe(() => {}, async () => {});
  unsubscribe();
  buffer.publish({ type: "context", value: { theme: "dark" } });
  const events: WidgetEvent[] = [];
  buffer.subscribe((event) => events.push(event), async () => {});
  assert.deepEqual(events.map((event) => event.type), ["input", "context"]);
  const context = events.find((event) => event.type === "context");
  assert.deepEqual(context?.value.availableDisplayModes, ["inline", "fullscreen"]);
  assert.equal(context?.value.theme, "dark");
});

test("teardown waits for flush and surfaces an unacknowledged save", async () => {
  const buffer = createAppEventBuffer();
  const app = {} as App;
  buffer.register(app);
  buffer.subscribe(() => {}, async () => { throw new Error("Not saved"); });
  await assert.rejects(async () => app.onteardown!({}, {} as never), /Not saved/);
});

test("dev harness delivers input before mount and implements full-scene CAS", async () => {
  const mock = createMockApp();
  mock.sendSceneInput(initial());
  mock.sendToolResult("checkpoint");
  const types: string[] = [];
  mock.events.subscribe((event) => types.push(event.type), async () => {});
  assert.deepEqual(types, ["input", "result"]);
  const saved = await mock.app.callServerTool({ name: "save_checkpoint", arguments: { id: "checkpoint", data: JSON.stringify(edited()), expectedRevision: 1 } });
  assert.equal(saved.structuredContent?.revision, 2);
  const stale = await mock.app.callServerTool({ name: "save_checkpoint", arguments: { id: "checkpoint", data: JSON.stringify(initial()), expectedRevision: 1 } });
  assert.equal(stale.isError, true);
  assert.equal(stale._meta?.code, "revision_conflict");
  assert.equal(stale._meta?.currentRevision, 2);
  const unversioned = await mock.app.callServerTool({ name: "save_checkpoint", arguments: { id: "checkpoint", data: JSON.stringify(initial()) } });
  assert.equal(unversioned.isError, true);
  assert.equal(unversioned._meta?.code, "revision_required");
  const read = await mock.app.callServerTool({ name: "read_checkpoint", arguments: { id: "checkpoint" } });
  assert.equal(parseSceneData(read.structuredContent).elements[0].text, "After");
  mock.checkpoints.set("legacy", { ...initial(), revision: 0 });
  const legacyPayload = { elements: edited().elements };
  const rejectedLegacy = await mock.app.callServerTool({ name: "save_checkpoint", arguments: { id: "legacy", data: JSON.stringify(legacyPayload), expectedRevision: 0 } });
  assert.equal(rejectedLegacy.isError, true);
  assert.equal(mock.checkpoints.get("legacy")?.revision, 0);
  const migrated = await mock.app.callServerTool({ name: "save_checkpoint", arguments: { id: "legacy", data: JSON.stringify(edited()), expectedRevision: 0 } });
  assert.equal(migrated.structuredContent?.revision, 1);

  const recovering: Checkpoint = {
    ...initial(), revision: 0,
    recovery: { missingFileIds: ["missing"], unavailableImages: [{ id: "lost", type: "image", x: 0, y: 0, fileId: "missing" }] },
  };
  mock.checkpoints.set("recovering", recovering);
  const blocked = await mock.app.callServerTool({ name: "save_checkpoint", arguments: { id: "recovering", data: JSON.stringify(edited()), expectedRevision: 0 } });
  assert.equal(blocked.isError, true);
  assert.deepEqual(mock.checkpoints.get("recovering"), recovering);
});
