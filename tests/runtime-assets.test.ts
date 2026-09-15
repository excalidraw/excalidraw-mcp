import assert from "node:assert/strict";
import { test } from "node:test";
import packageInfo from "../package.json" with { type: "json" };
import { excalidrawAssetPath, rewriteRuntimeAssetUrls, runtimeImports } from "../runtime-assets.ts";

test("browser imports and font assets derive from the pinned package graph", () => {
  assert.equal(runtimeImports.react, `https://esm.sh/react@${packageInfo.dependencies.react}`);
  assert.match(runtimeImports["react-dom/client"], new RegExp(`react-dom@${packageInfo.dependencies["react-dom"].replaceAll(".", "\\.")}/client`));
  assert.ok(runtimeImports["@excalidraw/excalidraw"].includes(`@${packageInfo.dependencies["@excalidraw/excalidraw"]}?`));
  assert.equal(excalidrawAssetPath, `https://esm.sh/@excalidraw/excalidraw@${packageInfo.dependencies["@excalidraw/excalidraw"]}/dist/prod/`);
  assert.equal(rewriteRuntimeAssetUrls('url("https://esm.sh/@excalidraw/excalidraw@0.17.0/dist/prod/fonts/test.woff2")'),
    `url("${excalidrawAssetPath}fonts/test.woff2")`);
});
