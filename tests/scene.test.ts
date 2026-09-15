import assert from "node:assert/strict";
import test from "node:test";
import {
  findRestoreCheckpoint, MissingSceneFilesError, parseElementsInput, parseSceneData,
  recoverLegacySceneData, reduceSceneOperations, SCENE_LIMITS, SceneValidationError, utf8ByteLength,
} from "../src/scene.ts";
import type { SceneElement } from "../src/scene.ts";

function box(id = "box", fields: Record<string, unknown> = {}) {
  return { type: "rectangle", id, x: 0, y: 0, width: 100, height: 60, ...fields };
}
function input(elements: unknown[]) { return parseElementsInput(JSON.stringify(elements)); }
function errorCode(code: string) {
  return (error: unknown) => error instanceof SceneValidationError && error.code === code;
}
const png = {
  id: "picture", mimeType: "image/png", created: 123,
  dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=",
};

test("empty scenes and legacy cameras normalize to a complete scene envelope", () => {
  assert.deepEqual(parseSceneData({ elements: [] }), { schemaVersion: 1, elements: [], files: {}, appState: {} });
  const scene = parseSceneData({ elements: [
    { type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 }, box(),
    { type: "cameraUpdate", x: -50, y: 30, width: 400, height: 300 },
  ] });
  assert.deepEqual(scene.viewport, { x: -50, y: 30, width: 400, height: 300 });
  assert.deepEqual(scene.elements.map(element => element.id), ["box"]);
  assert.deepEqual(parseSceneData(scene), scene);
});

test("standard elements, skeleton labels, explicit fonts, and custom JSON survive validation", () => {
  const scene = parseSceneData({ elements: [
    box("labeled", { label: { text: "Caption", fontFamily: 5, fontSize: 20 }, customData: { nested: [1, true, null] } }),
    { type: "text", id: "text", x: 1, y: 2, text: "hello", fontFamily: 2, index: null },
    { type: "arrow", id: "arrow", x: 100, y: 20, points: [[0, 0], [-25, 50]],
      start: { id: "labeled" }, end: { type: "rectangle", id: "inline", x: 20, y: 50 } },
  ] });
  assert.equal(scene.elements[0].label?.fontFamily, 5);
  assert.equal(scene.elements[1].fontFamily, 2);
  assert.equal(scene.elements[1].index, null);
  assert.equal(scene.elements[2].start?.id, "labeled");
  assert.equal(scene.elements[2].end?.id, "inline");
  assert.deepEqual(scene.elements[0].customData, { nested: [1, true, null] });
});

test("freehand geometry requires a nonempty array of points before conversion", () => {
  const stroke = { type: "freedraw", id: "stroke", x: 0, y: 0, width: 100, height: 60 };
  for (const invalid of [stroke, { ...stroke, points: [] }]) {
    assert.throws(() => parseSceneData({ elements: [invalid] }), errorCode("missing_points"));
    assert.throws(() => input([invalid]), errorCode("missing_points"));
  }
  assert.throws(() => input([{ ...stroke, points: [[0, "bad"]] }]), errorCode("invalid_number"));
  const points = [[0, 0], [20, -10]];
  assert.deepEqual(parseSceneData({ elements: [{ ...stroke, points }] }).elements[0].points, points);
  assert.deepEqual(parseSceneData({ elements: [{ ...stroke, points: [[0, 0]] }] }).elements[0].points, [[0, 0]]);
});

test("ordered deletes remove additions and their bound text instead of persisting animation placeholders", () => {
  const operations = input([
    box(), { type: "text", id: "label", x: 0, y: 0, text: "caption", containerId: "box" },
    { type: "delete", ids: "box,label" },
    box("replacement", { opacity: 1 }),
  ]);
  const original = JSON.stringify(operations);
  const scene = reduceSceneOperations(operations);
  assert.deepEqual(scene.elements.map(element => element.id), ["replacement"]);
  assert.equal(scene.elements[0].opacity, 1, "Legitimate opacity values are not mistaken for deletion markers");
  assert.equal(JSON.stringify(operations), original);
});

test("restoration applies the same ordered deletes to old and newly added elements", () => {
  const base = parseSceneData({ elements: [box("old")] });
  const operations = input([
    { type: "restoreCheckpoint", id: "checkpoint" }, box("added"),
    { type: "delete", ids: ["old", "added"] },
  ]);
  assert.equal(findRestoreCheckpoint(operations), "checkpoint");
  assert.deepEqual(reduceSceneOperations(operations, base).elements, []);
  assert.equal(base.elements.length, 1, "Reducer must not mutate the base");
  assert.throws(() => reduceSceneOperations(operations), errorCode("missing_restore"));
});

test("unknown delete IDs and duplicate or reused element IDs have useful errors", () => {
  assert.throws(() => reduceSceneOperations(input([{ type: "delete", ids: "missing" }])), errorCode("unknown_delete_target"));
  assert.throws(() => input([box(), box()]), errorCode("duplicate_element_id"));
  assert.throws(() => input([box(), { type: "delete", ids: "box" }, box()]), errorCode("duplicate_element_id"));
  assert.throws(() => reduceSceneOperations(input([box()]), parseSceneData({ elements: [box()] })), errorCode("duplicate_element_id"));
  assert.throws(() => input([{ type: "delete", ids: "x,x" }]), errorCode("duplicate_delete_id"));
  assert.throws(() => input([{ type: "delete", ids: "x,", id: "x" }]), errorCode("ambiguous_delete"));
  assert.throws(() => input([{ type: "delete", ids: "x," }]), errorCode("invalid_id"));
});

test("restore is unique and positioned first, including before camera operations", () => {
  const restore = { type: "restoreCheckpoint", id: "cp" };
  assert.throws(() => input([box(), restore]), errorCode("invalid_restore_order"));
  assert.throws(() => input([restore, restore]), errorCode("invalid_restore_order"));
  assert.throws(() => input([{ type: "cameraUpdate", x: 0, y: 0, width: 4, height: 3 }, restore]), errorCode("invalid_restore_order"));
  assert.throws(() => input([{ type: "restoreCheckpoint", id: "../escape" }]), errorCode("invalid_checkpoint_id"));
  assert.equal(findRestoreCheckpoint(input([box()])), undefined);
});

test("bindings survive when valid; only dangling references are detached", () => {
  const scene = reduceSceneOperations(input([
    box("a", { boundElements: [{ id: "arrow", type: "arrow" }, { id: "unknown", type: "text" }] }),
    box("b"),
    { type: "arrow", id: "arrow", x: 0, y: 0, points: [[0, 0], [1, 1]],
      startBinding: { elementId: "a", gap: 0, fixedPoint: [1, 0.5] },
      endBinding: { elementId: "b", focus: 0 } },
    { type: "text", id: "orphan", x: 0, y: 0, text: "keep my text", containerId: "never-present", frameId: "bad-frame" },
    { type: "delete", ids: "b" },
  ]));
  assert.equal(scene.elements[1].startBinding?.elementId, "a");
  assert.equal(scene.elements[1].endBinding, null);
  assert.deepEqual(scene.elements[0].boundElements, [{ id: "arrow", type: "arrow" }]);
  assert.equal(scene.elements[2].text, "keep my text");
  assert.equal(scene.elements[2].containerId, null);
  assert.equal(scene.elements[2].frameId, null);
});

test("deleted native elements and late bound labels are excluded from canonical state", () => {
  const native = parseSceneData({ elements: [
    box("deleted", { isDeleted: true }),
    { type: "text", id: "label", x: 0, y: 0, text: "deleted too", containerId: "deleted" },
  ] });
  assert.deepEqual(native.elements, []);
  const scene = reduceSceneOperations(input([
    box(), { type: "delete", ids: "box" },
    { type: "text", id: "late", x: 0, y: 0, text: "deleted", containerId: "box" },
  ]));
  assert.deepEqual(scene.elements, []);
});

test("scene files, persistent background/export settings, and camera survive restoration", () => {
  const base = parseSceneData({
    schemaVersion: 1,
    elements: [{ type: "image", id: "image", x: 0, y: 0, width: 1, height: 1, fileId: "picture", scale: [1, 1] }],
    files: { picture: png },
    appState: {
      viewBackgroundColor: "#112233", exportBackground: true, exportWithDarkMode: true,
      collaborators: new Map(), selectedElementIds: { image: true }, draggingElement: box(),
    },
    viewport: { x: 10, y: 10, width: 800, height: 600 },
  });
  const result = reduceSceneOperations(input([{ type: "restoreCheckpoint", id: "cp" }, box()]), base);
  assert.deepEqual(result.files, { picture: png });
  assert.deepEqual(result.appState, { viewBackgroundColor: "#112233", exportBackground: true, exportWithDarkMode: true });
  assert.deepEqual(result.viewport, base.viewport);
  result.files.picture.dataURL = "changed";
  result.appState.viewBackgroundColor = "changed";
  assert.equal(base.files.picture.dataURL, png.dataURL);
  assert.equal(base.appState.viewBackgroundColor, "#112233");
});

test("modern grid toggles persist independently of grid size, while legacy disabled grids remain readable", () => {
  for (const gridModeEnabled of [true, false]) {
    const base = parseSceneData({ elements: [], appState: { gridModeEnabled, gridSize: 20, gridStep: 5 } });
    const restored = reduceSceneOperations(input([{ type: "restoreCheckpoint", id: "grid" }]), base);
    assert.deepEqual(restored.appState, { gridModeEnabled, gridSize: 20, gridStep: 5 });
    assert.deepEqual(parseSceneData(restored).appState, restored.appState);
  }
  assert.deepEqual(parseSceneData({ elements: [], appState: { gridSize: null } }).appState, { gridSize: null });
  assert.throws(() => parseSceneData({ elements: [], appState: { gridModeEnabled: "true" } }), errorCode("invalid_boolean"));
});

test("missing legacy image bytes are explicit, never reconstructed or silently discarded", () => {
  assert.throws(
    () => parseSceneData({ elements: [{ type: "image", id: "image", x: 0, y: 0, fileId: "missing" }] }),
    (error: unknown) => error instanceof MissingSceneFilesError &&
      error.fileIds[0] === "missing" && error.message.includes("Legacy element-only checkpoints"),
  );
});

test("explicit legacy recovery retains usable content and quarantines missing image records with a warning", () => {
  const legacy = {
    elements: [
      box("recover-me"),
      { type: "image", id: "missing-image", x: 10, y: 20, width: 30, height: 40, fileId: "lost" },
      { type: "image", id: "available-image", x: 0, y: 0, fileId: "picture" },
      { type: "arrow", id: "arrow", x: 0, y: 0, endBinding: { elementId: "missing-image" } },
    ],
    files: { picture: png }, appState: { viewBackgroundColor: "#112233" },
  };
  const raw = JSON.stringify(legacy);
  const { scene, recovery } = recoverLegacySceneData(legacy);
  assert.deepEqual(scene.elements.map(entry => entry.id), ["recover-me", "available-image", "arrow"]);
  assert.equal(scene.elements[2].endBinding, null);
  assert.deepEqual(scene.files, legacy.files);
  assert.equal(scene.appState.viewBackgroundColor, "#112233");
  assert.deepEqual(recovery?.missingFileIds, ["lost"]);
  assert.deepEqual(recovery?.unavailableImages, [legacy.elements[1]]);
  assert.deepEqual(parseSceneData(scene), scene);
  assert.equal(JSON.stringify(legacy), raw);
  assert.throws(() => recoverLegacySceneData({ ...legacy, schemaVersion: 1 }), errorCode("not_legacy_scene"));
  assert.equal(recoverLegacySceneData({ elements: [] }).recovery, undefined);
});

test("files validate ID, MIME, data URL, base64, metadata, and size", () => {
  for (const invalid of [
    { ...png, id: "different" }, { ...png, mimeType: "text/html" },
    { ...png, dataURL: "https://example.com/image.png" },
    { ...png, dataURL: "data:image/jpeg;base64,AAAA" },
    { ...png, dataURL: "data:image/png;base64,not-base64" },
    { ...png, created: -1 }, { ...png, lastRetrieved: "yesterday" },
    { ...png, dataURL: `data:image/png;base64,${"A".repeat(Math.ceil((SCENE_LIMITS.maxFileBytes + 3) / 3) * 4)}` },
  ]) {
    assert.throws(() => parseSceneData({ elements: [], files: { picture: invalid } }), SceneValidationError);
  }
  assert.throws(() => parseSceneData({ elements: [], files: null }), errorCode("invalid_object"));
});

test("JSON structure, types, finite geometry, and strictly positive cameras are validated", () => {
  for (const json of ["{}", "null", "true", "[null]", '["box"]']) {
    assert.throws(() => parseElementsInput(json), SceneValidationError);
  }
  assert.throws(() => parseElementsInput("[{"), errorCode("invalid_json"));
  for (const invalid of [
    box("x", { x: Infinity }), box("x", { y: NaN }), box("x", { width: -1 }),
    box("x", { opacity: 101 }), box("x", { strokeColor: 123 }),
    box("x", { groupIds: [1] }), box("x", { fillStyle: "invalid" }),
    box("x", { crop: { x: 0, y: 0, width: "bad", height: 1, naturalWidth: 1, naturalHeight: 1 } }),
    { type: "arrow", id: "arrow", x: 0, y: 0, start: {} },
    { type: "arrow", id: "arrow", x: 0, y: 0, fixedSegments: [{ start: [0, 0], end: ["bad", 1], index: 1 }] },
    { type: "arrow", id: "arrow", x: 0, y: 0, points: [[0, "bad"]] },
    { type: "text", id: "text", x: 0, y: 0 },
  ]) assert.throws(() => parseSceneData({ elements: [invalid] }), SceneValidationError);
  for (const width of [0, -1, Infinity, NaN]) {
    assert.throws(() => parseSceneData({ elements: [], viewport: { x: 0, y: 0, width, height: 100 } }), SceneValidationError);
  }
  assert.throws(() => parseSceneData({ schemaVersion: 2, elements: [] }), errorCode("unsupported_schema"));
  assert.throws(() => parseSceneData({ schemaVersion: 1, files: {}, appState: {}, elements: [{ type: "cameraUpdate", x: 0, y: 0, width: 4, height: 3 }] }), errorCode("noncanonical_scene"));
  assert.throws(() => parseSceneData({ schemaVersion: 1, elements: [] }), errorCode("incomplete_scene"));
});

test("reserved keys, cyclic custom data, non-JSON values, and excessive depth are rejected", () => {
  assert.throws(() => parseElementsInput('[{"type":"rectangle","id":"a","x":0,"y":0,"__proto__":{"polluted":true}}]'), errorCode("invalid_json_key"));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => parseSceneData({ elements: [box("a", { customData: circular })] }), errorCode("invalid_json_value"));
  assert.throws(() => parseSceneData({ elements: [box("a", { customData: { fn: () => 1 } })] }), errorCode("invalid_json_value"));
  let nested: unknown = {};
  for (let index = 0; index < 40; index++) nested = { nested };
  assert.throws(() => parseSceneData({ elements: [box("a", { customData: nested })] }), errorCode("complexity_limit"));
});

test("UTF-8 and post-restore size limits cannot be bypassed using multibyte text", () => {
  assert.equal(utf8ByteLength("a界😀"), 8);
  const large = "界".repeat(900_000);
  const base = parseSceneData({ elements: [box("base", { customData: { large } })] });
  const additions = input([box("added", { customData: { large } })]);
  assert.throws(() => reduceSceneOperations(additions, base), errorCode("scene_size_limit"));
  assert.throws(() => parseElementsInput(JSON.stringify([box("huge", { customData: { large: large.repeat(2) } })])), errorCode("input_size_limit"));
  assert.throws(() => parseSceneData({ elements: [box("huge", { customData: { large: large.repeat(2) } })] }), errorCode("scene_size_limit"));
});

test("combined scene element counts are bounded after restoration", () => {
  const base = parseSceneData({ elements: Array.from({ length: SCENE_LIMITS.maxElements }, (_, index) => box(`b${index}`)) });
  assert.throws(() => reduceSceneOperations(input([box("extra")]), base), errorCode("element_limit"));
});

test("the open SceneElement contract accepts typed JSON without unchecked any values", () => {
  const element: SceneElement = { type: "rectangle", id: "typed", x: 0, y: 0, label: { text: "typed label" }, customData: { source: "test" } };
  assert.equal(reduceSceneOperations([element]).elements[0].label?.text, "typed label");
});
