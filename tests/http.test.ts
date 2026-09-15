import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createHttpHandler, httpPolicyFromEnv } from "../src/http.js";

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function request(method: string, params: Record<string, unknown> = {}, id = 1): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
  if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
  if (method === "resources/read") headers["Mcp-Name"] = String(params.uri);
  return new Request("http://localhost/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: meta, ...params } }),
  });
}

function factory() {
  const server = new McpServer({ name: "test", version: "1" });
  server.registerTool("echo", {
    inputSchema: z.object({ text: z.string(), wait: z.number().default(0) }),
  }, async ({ text, wait }) => {
    await delay(wait);
    return { content: [{ type: "text", text }] };
  });
  server.registerResource("test", "test://resource", { mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "resource content" }] }));
  return server;
}

test("modern calls work without initialization and include discovery/cache wire fields", async (t) => {
  const handler = createHttpHandler(factory);
  t.after(handler.close);
  const direct = await handler.fetch(request("tools/call", { name: "echo", arguments: { text: "direct" } }));
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).result.content[0].text, "direct");
  for (const method of ["server/discover", "tools/list", "resources/list", "resources/templates/list", "resources/read"]) {
    const response = await handler.fetch(request(method, method === "resources/read" ? { uri: "test://resource" } : {}));
    assert.equal(response.status, 200, method);
    const { result } = await response.json();
    assert.equal(result.resultType, "complete", method);
    assert.equal(result.ttlMs, 0, method);
    assert.equal(result.cacheScope, "private", method);
    if (method === "server/discover") {
      assert.ok(result.supportedVersions.includes("2026-07-28"));
      assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "test");
    }
  }
});

test("simultaneous requests with identical IDs use independent instances", async (t) => {
  let instances = 0;
  const handler = createHttpHandler(() => { instances++; return factory(); });
  t.after(handler.close);
  const [a, b] = await Promise.all([
    handler.fetch(request("tools/call", { name: "echo", arguments: { text: "A", wait: 30 } }, 1)),
    handler.fetch(request("tools/call", { name: "echo", arguments: { text: "B" } }, 1)),
  ]);
  assert.equal((await a.json()).result.content[0].text, "A");
  assert.equal((await b.json()).result.content[0].text, "B");
  assert.equal(instances, 2);
});

test("modern invalid metadata and mirrored headers do not fall back to legacy", async (t) => {
  const handler = createHttpHandler(factory);
  t.after(handler.close);
  const mismatched = request("server/discover");
  mismatched.headers.set("Mcp-Method", "tools/list");
  const response = await handler.fetch(mismatched);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, -32020);
  const missing = await handler.fetch(request("server/discover", {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
  }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, -32602);
  const unsupported = request("server/discover", {
    _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
  });
  unsupported.headers.set("MCP-Protocol-Version", "2099-01-01");
  const refused = await handler.fetch(unsupported);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, -32022);
});

test("legacy initialization remains supported without session IDs", async (t) => {
  const handler = createHttpHandler(factory);
  t.after(handler.close);
  const response = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.match(await response.text(), /"protocolVersion":"2025-11-25"/);
});

test("host and origin validation precede MCP dispatch and modern preflight works", async (t) => {
  let instances = 0;
  const handler = createHttpHandler(() => { instances++; return factory(); });
  t.after(handler.close);
  assert.equal((await handler.fetch(new Request("http://evil.example/mcp"))).status, 403);
  const badOrigin = request("server/discover");
  badOrigin.headers.set("Origin", "https://evil.example");
  assert.equal((await handler.fetch(badOrigin)).status, 403);
  const nullOrigin = request("server/discover");
  nullOrigin.headers.set("Origin", "null");
  assert.equal((await handler.fetch(nullOrigin)).status, 403);
  const preflight = await handler.fetch(new Request("http://localhost/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type,MCP-Protocol-Version,Mcp-Method,Mcp-Name",
    },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173");
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /mcp-protocol-version/);
  assert.equal(instances, 0);
  for (const method of ["GET", "DELETE"]) {
    assert.equal((await handler.fetch(new Request("http://localhost/mcp", { method }))).status, 405);
  }
});

test("request bytes are bounded without a Content-Length header", async (t) => {
  const handler = createHttpHandler(factory, {
    allowedHosts: ["localhost"], allowedOrigins: ["localhost"], maxRequestBytes: 64,
  });
  t.after(handler.close);
  const response = await handler.fetch(request("tools/call", { name: "echo", arguments: { text: "x".repeat(100) } }));
  assert.equal(response.status, 413);
});

test("network binding is explicit and wildcard/URL allow-lists are rejected", () => {
  assert.throws(() => httpPolicyFromEnv({ EXCALIDRAW_HOST: "0.0.0.0" }), /requires/);
  assert.throws(() => httpPolicyFromEnv({ EXCALIDRAW_ALLOWED_HOSTS: "*" }), /wildcards/);
  assert.throws(() => httpPolicyFromEnv({ EXCALIDRAW_ALLOWED_HOSTS: "https://example.com" }), /hostnames/);
  assert.deepEqual(httpPolicyFromEnv({
    VERCEL: "1", VERCEL_URL: "preview.vercel.app",
    EXCALIDRAW_ALLOWED_ORIGINS: "example.com",
  }), { allowedHosts: ["preview.vercel.app"], allowedOrigins: ["example.com"] });
});

test("cancelling the SSE response aborts the active request", async (t) => {
  let aborted!: () => void;
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  const handler = createHttpHandler(() => {
    const server = new McpServer({ name: "cancel-test", version: "1" });
    server.registerTool("wait", { inputSchema: z.object({}) }, async (_args, ctx) => {
      await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: "progress", progress: 1 } });
      await new Promise<void>((resolve) => {
        const done = () => { aborted(); resolve(); };
        if (ctx.mcpReq.signal.aborted) done();
        else ctx.mcpReq.signal.addEventListener("abort", done, { once: true });
      });
      return { content: [] };
    });
    return server;
  });
  t.after(handler.close);
  const response = await handler.fetch(request("tools/call", {
    name: "wait", arguments: {}, _meta: { ...meta, progressToken: "progress" },
  }));
  assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
  await response.body?.cancel();
  await Promise.race([cancelled, delay(1000).then(() => { throw new Error("Request was not cancelled"); })]);
});
