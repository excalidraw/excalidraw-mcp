import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/mcp-app.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("mcp-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ExcalidrawApp");
assert.ok(wrapper, "Missing App bootstrap component");
const code = ts.transpileModule(wrapper.getText(ast), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

test("notifications received before connection retain the latest input and result for the core", () => {
  const pending = { current: {} };
  const app = {};
  const partial = { arguments: { elements: "[" } };
  const complete = { arguments: { elements: "[]" } };
  const result = { structuredContent: { checkpointId: "early-checkpoint" } };
  const component = runInNewContext(`${code}\nExcalidrawApp`, {
    exports: {}, ExcalidrawAppCore: function Core() {},
    require: () => ({ jsx: (type, props) => ({ type, props }) }),
    useRef: () => pending,
    useApp(options) {
      assert.equal(typeof options.onAppCreated, "function", "Handlers must be installed before connect");
      options.onAppCreated(app);
      app.ontoolinputpartial(partial);
      app.ontoolinput(complete);
      app.ontoolresult(result);
      return { app, error: null };
    },
  });
  const rendered = component();
  assert.equal(rendered.props.app, app);
  assert.equal(rendered.props.pending, pending.current);
  assert.equal(pending.current.input.params, complete);
  assert.equal(pending.current.input.final, true);
  assert.equal(pending.current.result, result);
});
