import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/mcp-app.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("mcp-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helper = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "convertRawElements");
assert.ok(helper, "Missing App checkpoint normalizer");
const code = ts.transpileModule(helper.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup() {
  const calls = [];
  // The converter spy changes geometry so accidental reconversion cannot pass unnoticed.
  const normalize = runInNewContext(`${code}\nconvertRawElements`, {
    FONT_FAMILY: { Excalifont: 5 },
    convertToExcalidrawElements(elements, options) {
      calls.push({ elements, options });
      return elements.map((element) => ({ ...element, version: 1, x: element.x - 25, y: element.y - 12,
        boundElements: [...(element.boundElements ?? []), ...elements.filter((arrow) =>
          arrow.type === "arrow" && (arrow.start?.id === element.id || arrow.end?.id === element.id))
          .map((arrow) => ({ id: arrow.id, type: "arrow" }))] }));
    },
  });
  const box = { type: "rectangle", id: "box", version: 1, x: 70, y: 90, width: 220, height: 100,
    boundElements: [{ id: "label", type: "text" }] };
  const label = { type: "text", id: "label", version: 2, x: 140, y: 130, width: 80, height: 20,
    text: "Saved", textAlign: "center", verticalAlign: "middle", fontFamily: 2, containerId: box.id };
  return { normalize, calls, saved: [box, label] };
}

test("complete checkpoints keep measured geometry, font and bindings without conversion", () => {
  const { normalize, calls, saved } = setup();
  assert.deepEqual(Array.from(normalize(saved)), saved);
  assert.equal(calls.length, 0);
});

test("repeated checkpoint restores are idempotent", () => {
  const { normalize, saved } = setup();
  assert.deepEqual(Array.from(normalize(normalize(saved))), saved);
});

test("mixed input retains saved elements and drawing order while converting shorthand", () => {
  const { normalize, calls, saved } = setup();
  const raw = { type: "text", id: "new", x: 400, y: 100, text: "New" };
  const restored = Array.from(normalize([saved[0], raw, saved[1]]));
  assert.deepEqual(restored.map((element) => element.id), ["box", "new", "label"]);
  assert.deepEqual([restored[0], restored[2]], saved);
  assert.equal(restored[1].x, 375);
  assert.equal(restored[1].fontFamily, 5);
  assert.equal(calls[0].options.regenerateIds, false);
});

test("new shorthand still receives centered label defaults", () => {
  const { normalize, calls } = setup();
  normalize([{ type: "rectangle", x: 0, y: 0, label: { text: "New", textAlign: "left" } }]);
  assert.equal(calls[0].elements[0].label.textAlign, "left");
  assert.equal(calls[0].elements[0].label.verticalAlign, "middle");
});

test("new shorthand arrows keep reciprocal bindings on saved containers", () => {
  const { normalize, saved } = setup();
  const target = { ...saved[0], id: "target", boundElements: [] };
  const arrow = { type: "arrow", id: "new-arrow", x: 290, y: 140, start: { id: "box" }, end: { id: "target" } };
  const restored = Array.from(normalize([...saved, target, arrow]));
  for (const original of [saved[0], target]) {
    const box = restored.find((element) => element.id === original.id);
    assert.deepEqual(Array.from(box.boundElements), [...original.boundElements, { id: arrow.id, type: "arrow" }]);
    assert.equal(box.x, original.x);
    assert.equal(box.y, original.y);
  }
  assert.deepEqual(restored.find((element) => element.id === saved[1].id), saved[1]);
  assert.deepEqual(Array.from(normalize(restored)), restored);
});

test("camera and control pseudo-elements survive without reaching the converter", () => {
  const { normalize, calls, saved } = setup();
  const controls = [{ type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 },
    { type: "delete", ids: "old" }, { type: "restoreCheckpoint", id: "checkpoint" }];
  assert.deepEqual(Array.from(normalize([...saved, ...controls])), [...saved, ...controls]);
  assert.equal(calls.length, 0);
});

test("empty input remains empty", () => {
  assert.deepEqual(Array.from(setup().normalize([])), []);
});
