import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerTools } from "../dist/server.js";

test("tool annotations reflect state mutation", () => {
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
      return {};
    },
    registerResource() {
      return {};
    },
  };
  const store = {
    async save() {},
    async load() {
      return null;
    },
  };
  const distDir = fileURLToPath(new URL("../dist", import.meta.url));

  registerTools(server, distDir, store);

  assert.equal(tools.get("read_me").config.annotations.readOnlyHint, true);
  assert.equal(tools.get("create_view").config.annotations.readOnlyHint, false);
  assert.deepEqual(
    tools.get("save_checkpoint").config._meta.ui.visibility,
    ["app"],
  );
});
