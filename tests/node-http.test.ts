import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as httpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { createLocalHttpApp } from "../src/main.js";
import { MAX_HTTP_BYTES } from "../src/http.js";

test("local HTTP accepts larger diagrams and bounds parsing with visible CORS errors", async (t) => {
  const { app, handler } = createLocalHttpApp(() => new McpServer({ name: "test", version: "1" }));
  const server = httpServer(app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const headers = {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    Origin: "http://localhost:5173", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover",
  };
  const response = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "server/discover",
      params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        padding: "x".repeat(128 * 1024),
      } },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.resultType, "complete");
  const large = await fetch(url, { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(MAX_HTTP_BYTES) }) });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), {
    jsonrpc: "2.0", id: null,
    error: { code: -32600, message: `HTTP requests must not exceed ${MAX_HTTP_BYTES} bytes.` },
  });
  assert.equal(large.headers.get("Access-Control-Allow-Origin"), headers.Origin);
  const invalid = await fetch(url, { method: "POST", headers, body: "{" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    jsonrpc: "2.0", id: null,
    error: { code: -32700, message: "Request body must be valid JSON." },
  });
  assert.equal(invalid.headers.get("Access-Control-Allow-Origin"), headers.Origin);
  const denied = await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{" });
  assert.equal(denied.status, 403);
});
