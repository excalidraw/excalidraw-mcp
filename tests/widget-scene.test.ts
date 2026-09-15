import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import test from "node:test";
import { parseSceneData, type SceneData } from "../src/scene.js";

// Vite already depends on esbuild. Bundle the actual installed drawing library in memory;
// no generated files, browser, CDN assets, or additional test dependency are needed.
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    contents: 'export * from "./src/widget-scene.ts"; export { convertToExcalidrawElements } from "@excalidraw/excalidraw";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts",
  },
  bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "empty", ".css": "empty" },
});
const unexpectedNetwork = () => { throw new Error("Network access is forbidden in converter tests"); };
const noop = () => {};
const canvasContext = {
  measureText: (text: string) => ({ width: text.length * 10, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }), scale: noop, clearRect: noop, fillText: noop,
};
const document = {
  createElement: (tag: string) => ({
    tagName: tag.toUpperCase(), style: {}, setAttribute: noop, remove: noop,
    getContext: () => canvasContext, addEventListener: noop, appendChild: noop,
  }),
  documentElement: { style: {} },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, fonts: { check: () => true, load: async () => [], add: noop },
};
const location = { origin: "https://fixture.invalid", href: "https://fixture.invalid/" };
const window = {
  document, location, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
};
const module = { exports: {} as typeof import("../src/widget-scene.js") & {
  convertToExcalidrawElements: typeof import("@excalidraw/excalidraw").convertToExcalidrawElements;
} };
const globals = {
  exports: module.exports, module, window, document, location, devicePixelRatio: 1,
  navigator: { platform: "test", userAgent: "node", language: "en-US" },
  fetch: unexpectedNetwork, XMLHttpRequest: unexpectedNetwork, Image: unexpectedNetwork,
  Element: class { replaceChildren() {} }, HTMLElement: class {}, DocumentFragment: class {},
  FontFace: class { status = "loaded"; loaded = Promise.resolve(this); load() { return this.loaded; } },
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
};
compileFunction(bundle.outputFiles[0].text, Object.keys(globals), { filename: "excalidraw-converter.fixture.cjs" })(...Object.values(globals));
const { toNativeScene, serializeScene, convertToExcalidrawElements } = module.exports;

const box = (id: string, x: number) => ({ id, type: "rectangle" as const, x, y: 0, width: 100, height: 80 });
const arrow = {
  id: "connector", type: "arrow" as const, x: 100, y: 40, width: 100, height: 0,
  points: [[0, 0], [100, 0]], startArrowhead: null, endArrowhead: "arrow",
};
function assertBindings(scene: SceneData) {
  const connector = scene.elements.find((element) => element.id === "connector")!;
  assert.equal(connector.startBinding?.elementId, "left");
  assert.equal(connector.endBinding?.elementId, "right");
  for (const id of ["left", "right"]) {
    assert.deepEqual(scene.elements.find((element) => element.id === id)?.boundElements, [{ id: "connector", type: "arrow" }]);
  }
  assert.deepEqual(parseSceneData(JSON.parse(serializeScene(scene))).elements, scene.elements, "Validation/export roundtrip preserves complete native elements");
}

test("actual converter loads and converts ordinary shapes before binding regression assertions", () => {
  const native = toNativeScene(parseSceneData({ elements: [box("left", 0)] }));
  assert.equal(native.elements[0].id, "left");
  assert.equal(typeof native.elements[0].version, "number");
  assert.equal(native.elements[0].width, 100);
});

test("versionless documented explicit arrow bindings survive actual Excalidraw skeleton conversion", () => {
  const input = parseSceneData({ elements: [
    box("left", 0), box("right", 200),
    { ...arrow, startBinding: { elementId: "left", focus: 0.25, gap: 7 }, endBinding: { elementId: "right" } },
  ] });
  const original = JSON.stringify(input);
  const native = toNativeScene(input);
  assertBindings(native);
  const connector = native.elements.find((element) => element.id === "connector")!;
  assert.equal(connector.startBinding?.focus, 0.25);
  assert.equal(connector.startBinding?.gap, 7);
  assert.equal(connector.endBinding?.focus, 0);
  assert.equal(connector.endBinding?.gap, 0);
  assert.equal(JSON.stringify(input), original, "Conversion must not mutate the validated source");
});

test("explicit bindings also connect versionless arrows to already-native shape controls", () => {
  const shapes = toNativeScene(parseSceneData({ elements: [box("left", 0), box("right", 200)] }));
  const native = toNativeScene(parseSceneData({ elements: [
    ...shapes.elements,
    { ...arrow, startBinding: { elementId: "left" }, endBinding: { elementId: "right", focus: -0.2, gap: 9 } },
  ] }));
  assertBindings(native);
  const connector = native.elements.find((element) => element.id === "connector")!;
  assert.equal(connector.endBinding?.focus, -0.2);
  assert.equal(connector.endBinding?.gap, 9);
});

test("native bindings and documented shorthand start/end remain supported by the real converter", () => {
  const converted = convertToExcalidrawElements([
    box("left", 0), box("right", 200),
    { ...arrow, start: { id: "left" }, end: { id: "right" } },
  ] as Parameters<typeof convertToExcalidrawElements>[0], { regenerateIds: false });
  const native = toNativeScene(parseSceneData({ elements: converted }));
  assertBindings(native);
  const shorthand = toNativeScene(parseSceneData({ elements: [
    box("left", 0), box("right", 200), { ...arrow, start: { id: "left" }, end: { id: "right" } },
  ] }));
  assertBindings(shorthand);
});

for (const version of [undefined, 1]) {
  test(`valid ${version === undefined ? "versionless" : "native"} freedraw normalizes through the installed converter and restorer`, () => {
    const input = parseSceneData({ elements: [{
      id: "stroke", type: "freedraw", x: 10, y: 20, width: 20, height: 15,
      points: [[0, 0], [10, 5], [20, 15]], pressures: [0.5, 0.6, 0.5], simulatePressure: false,
      ...(version === undefined ? {} : { version }),
    }] });
    const native = toNativeScene(input);
    assert.deepEqual(native.elements[0].points, input.elements[0].points);
    if (version === undefined) assert.equal(native.elements[0].version, 1);
    else assert.ok(Number.isSafeInteger(native.elements[0].version) && Number(native.elements[0].version) >= version);
    assert.deepEqual(parseSceneData(JSON.parse(serializeScene(native))).elements[0].points, input.elements[0].points);
  });
}
