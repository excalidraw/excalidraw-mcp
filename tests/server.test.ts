import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { FileCheckpointStore, MemoryCheckpointStore, type CheckpointStore } from "../src/checkpoint-store.js";
import { createHttpHandler } from "../src/http.js";
import { createServer } from "../src/server.js";
import { RESOURCE_URI, RESOURCE_MIME_TYPE } from "../src/metadata.js";

const rectangle = { type: "rectangle", id: "box", x: 10, y: 20, width: 100, height: 60 };
const image = { type: "image", id: "image", x: 10, y: 20, width: 20, height: 20, fileId: "asset", scale: [1, 1] };
const files = {
  asset: {
    id: "asset", mimeType: "image/png", created: 1,
    dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  },
};

function fixture(store: CheckpointStore = new MemoryCheckpointStore()) {
  const handler = createHttpHandler(() => createServer(store));
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name, arguments: args,
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
        },
      }),
    }));
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.ok(message.result, JSON.stringify(message));
    return message.result;
  };
  return { store, handler, call };
}

test("create_view applies deletes to both standalone and restored new elements", async (t) => {
  const { store, handler, call } = fixture();
  t.after(handler.close);
  const deleted = await call("create_view", { elements: JSON.stringify([rectangle, { type: "delete", ids: "box" }]) });
  assert.ok(!deleted.isError, JSON.stringify(deleted));
  assert.deepEqual((await store.load(deleted.structuredContent.checkpointId))?.elements, []);
  const base = await call("create_view", { elements: JSON.stringify([{ ...rectangle, id: "base" }]) });
  const restored = await call("create_view", { elements: JSON.stringify([
    { type: "restoreCheckpoint", id: base.structuredContent.checkpointId },
    rectangle, { type: "delete", ids: "box" },
  ]) });
  assert.ok(!restored.isError, JSON.stringify(restored));
  const saved = await store.load(restored.structuredContent.checkpointId);
  assert.deepEqual(saved?.elements.map((element) => element.id), ["base"]);
});

test("malformed scenes return actionable tool errors and do not poison checkpoints", async (t) => {
  const { handler, call } = fixture();
  t.after(handler.close);
  for (const elements of ["{}", "null", "[null]", "[", JSON.stringify([{ ...rectangle, x: "bad" }])]) {
    const result = await call("create_view", { elements });
    assert.equal(result.isError, true, elements);
    assert.doesNotMatch(result.content[0].text, /find is not a function|reading 'type'/);
  }
  assert.equal((await call("create_view", {})).isError, true);
  assert.equal((await call("create_view", { elements: "[]", scene: '{"elements":[]}' })).isError, true);
  const badSave = await call("save_checkpoint", { id: "invalid", data: "{}", expectedRevision: 0 });
  assert.equal(badSave.isError, true);
  const partialSave = await call("save_checkpoint", {
    id: "invalid", data: '{"schemaVersion":1,"elements":[]}', expectedRevision: 0,
  });
  assert.equal(partialSave.isError, true);
  assert.match(partialSave.content[0].text, /files and appState/);
});

test("invalid freehand geometry never creates a successful checkpoint", async (t) => {
  const store = new MemoryCheckpointStore();
  const save = store.save.bind(store);
  let saves = 0;
  store.save = async (...args) => { saves++; return save(...args); };
  const { handler, call } = fixture(store);
  t.after(handler.close);
  const stroke = { type: "freedraw", id: "stroke", x: 0, y: 0, width: 100, height: 60 };
  for (const element of [stroke, { ...stroke, points: [] }]) {
    for (const args of [
      { elements: JSON.stringify([element]) },
      { scene: JSON.stringify({ elements: [element], files: {}, appState: {} }) },
    ]) {
      const result = await call("create_view", args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Freehand elements require at least one/);
    }
  }
  assert.equal(saves, 0);
  const valid = await call("create_view", { elements: JSON.stringify([{ ...stroke, points: [[0, 0], [100, 60]] }]) });
  assert.ok(!valid.isError, JSON.stringify(valid));
  assert.equal(saves, 1);
});

test("complete scenes retain image files, appearance and revisioned empty edits", async (t) => {
  const { store, handler, call } = fixture();
  t.after(handler.close);
  const created = await call("create_view", {
    scene: JSON.stringify({ elements: [image], files, appState: { viewBackgroundColor: "#123456" } }),
  });
  assert.ok(!created.isError, JSON.stringify(created));
  const { checkpointId, revision } = created.structuredContent;
  const read = await call("read_checkpoint", { id: checkpointId });
  assert.equal(read.structuredContent.files.asset.dataURL, files.asset.dataURL);
  assert.equal(read.structuredContent.appState.viewBackgroundColor, "#123456");
  const empty = { schemaVersion: 1, elements: [], files: {}, appState: { viewBackgroundColor: "#123456" } };
  const saved = await call("save_checkpoint", { id: checkpointId, expectedRevision: revision, data: JSON.stringify(empty) });
  assert.ok(!saved.isError, JSON.stringify(saved));
  assert.equal(saved.structuredContent.revision, revision + 1);
  const conflict = await call("save_checkpoint", { id: checkpointId, expectedRevision: revision, data: JSON.stringify(empty) });
  assert.equal(conflict.isError, true);
  assert.equal(conflict._meta.code, "revision_conflict");
  assert.equal(conflict._meta.currentRevision, revision + 1);
  const oldWriter = await call("save_checkpoint", { id: checkpointId, data: '{"elements":[]}' });
  assert.equal(oldWriter.isError, true);
  assert.deepEqual((await store.load(checkpointId))?.elements, []);
});

test("sharing rejects image loss and malformed JSON before any external upload", async (t) => {
  const { handler, call } = fixture();
  t.after(handler.close);
  const original = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = async () => { uploads++; return Response.json({ id: "test" }); };
  t.after(() => { globalThis.fetch = original; });
  const result = await call("export_to_excalidraw", {
    json: JSON.stringify({ elements: [image], files, appState: {} }),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Download the \.excalidraw file/);
  assert.equal((await call("export_to_excalidraw", { json: "not json" })).isError, true);
  assert.equal(uploads, 0);
});

test("shape sharing preserves Excalidraw framing, encryption, and scene content", async (t) => {
  const { handler, call } = fixture();
  t.after(handler.close);
  const original = globalThis.fetch;
  let payload: Uint8Array | undefined;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://json.excalidraw.com/api/v2/post/");
    assert.equal(options?.method, "POST");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.ok(options?.body instanceof Uint8Array);
    payload = options.body;
    return Response.json({ id: "shape-share" });
  };
  t.after(() => { globalThis.fetch = original; });

  function unpack(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0), 1);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = 4;
    while (offset < bytes.length) {
      const length = view.getUint32(offset);
      offset += 4;
      assert.ok(offset + length <= bytes.length);
      parts.push(bytes.slice(offset, offset + length));
      offset += length;
    }
    assert.equal(offset, bytes.length);
    return parts;
  }

  const appState = { viewBackgroundColor: "#123456", exportBackground: true };
  const result = await call("export_to_excalidraw", {
    json: JSON.stringify({ schemaVersion: 1, elements: [rectangle], files: {}, appState }),
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(payload);
  const url = new URL(result.content[0].text);
  assert.equal(url.origin, "https://excalidraw.com");
  const [id, encodedKey] = url.hash.slice("#json=".length).split(",");
  assert.equal(id, "shape-share");
  const outer = unpack(payload);
  assert.equal(outer.length, 3);
  const [metadata, iv, encrypted] = outer;
  assert.deepEqual(JSON.parse(new TextDecoder().decode(metadata)), {
    version: 2, compression: "pako@1", encryption: "AES-GCM",
  });
  assert.equal(iv.length, 12);
  const key = await crypto.subtle.importKey("raw", Buffer.from(encodedKey, "base64url"), "AES-GCM", false, ["decrypt"]);
  const compressed = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  const inner = unpack(inflateSync(new Uint8Array(compressed)));
  assert.equal(inner.length, 2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(inner[0])), {});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(inner[1])), {
    type: "excalidraw", version: 2, source: "https://excalidraw.com",
    elements: [rectangle], appState,
  });
});

test("text fallback is meaningful and does not invent a host tool", async (t) => {
  const { handler, call } = fixture();
  t.after(handler.close);
  const result = await call("create_view", {
    elements: JSON.stringify([{ ...rectangle, label: { text: "API server" } }]),
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(result.content[0].text, /API server/);
  assert.doesNotMatch(result.content[0].text, /read_widget_context/);
  assert.deepEqual(JSON.parse(result.content[1].text), result.structuredContent);
});

test("every complete diagram example in read_me remains valid input", async (t) => {
  const { handler, call } = fixture();
  t.after(handler.close);
  const reference = await call("read_me", {});
  const text: string = reference.content[0].text;
  const examples = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  assert.ok(examples.length >= 4);
  for (const [index, example] of examples.entries()) {
    const created = await call("create_view", { elements: example[1] });
    assert.ok(!created.isError, `Example ${index + 1}: ${JSON.stringify(created)}`);
  }
});

test("legacy revision zero migrates explicitly and recovery loss is disclosed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "excalidraw-legacy-tool-"));
  const { store, handler, call } = fixture(new FileCheckpointStore({ directory: dir, legacyDirectory: false }));
  t.after(async () => { await handler.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "legacy.json"), JSON.stringify({ elements: [rectangle] }));
  const old = await call("read_checkpoint", { id: "legacy" });
  assert.equal(old.structuredContent.revision, 0);
  const migrated = await call("save_checkpoint", {
    id: "legacy", expectedRevision: 0, data: JSON.stringify(old.structuredContent),
  });
  assert.ok(!migrated.isError, JSON.stringify(migrated));
  assert.equal((await store.load("legacy"))?.revision, 1);
  await writeFile(path.join(dir, "missing-images.json"), JSON.stringify({ elements: [rectangle, image] }));
  const restored = await call("create_view", {
    elements: JSON.stringify([{ type: "restoreCheckpoint", id: "missing-images" }]),
  });
  assert.ok(!restored.isError, JSON.stringify(restored));
  assert.match(restored.structuredContent.warnings[0], /Legacy images are unavailable/);
  assert.match(restored.content[0].text, /Warning:/);
  assert.equal((await store.load("missing-images"))?.revision, 0);
});

test("UI resource returns MIME, CSP and cache metadata on the modern wire", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "excalidraw-resource-test-"));
  await writeFile(path.join(dir, "mcp-app.html"), "<!doctype html><html><body>test</body></html>");
  const handler = createHttpHandler(() => createServer(new MemoryCheckpointStore(), dir));
  t.after(async () => { await handler.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "resources/read", "Mcp-Name": RESOURCE_URI,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "resources/read",
      params: { uri: RESOURCE_URI, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    }),
  }));
  assert.equal(response.status, 200);
  const { result } = await response.json();
  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 0);
  assert.equal(result.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.deepEqual(result.contents[0]._meta.ui.csp.resourceDomains, ["https://esm.sh"]);
  assert.equal(result.contents[0]._meta.ui.prefersBorder, true);
  const discovery = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    }),
  }));
  const capabilities = (await discovery.json()).result.capabilities;
  assert.equal(capabilities.tools.listChanged, false);
  assert.equal(capabilities.resources.listChanged, false);
});
