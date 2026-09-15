import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function start(t: TestContext) {
  const sourceArgs = [
    "--experimental-strip-types", "--import", new URL("../scripts/register-ts.mjs", import.meta.url).href,
    fileURLToPath(new URL("./fixtures/stdio.ts", import.meta.url)),
  ];
  const args = process.env.MCP_TEST_DIST === "1"
    ? [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "--stdio"]
    : sourceArgs;
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
  child.on("exit", () => {
    for (const entry of pending.values()) entry.reject(new Error(`stdio exited: ${stderr}`));
  });
  lines.on("line", (line) => {
    try {
      const response: RpcResponse = JSON.parse(line);
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
    } catch (error) {
      for (const entry of pending.values()) entry.reject(new Error("Non-JSON data on stdout", { cause: error }));
    }
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    lines.close();
  });
  let nextId = 1;
  return async (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio request timed out: ${stderr}`)), 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    assert.ok(!response.error, JSON.stringify(response));
    assert.ok(response.result);
    if (method === "initialize") {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }
    return response.result;
  };
}

test("modern stdio accepts tools before initialize or discover", async (t) => {
  const call = start(t);
  const _meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const tool = await call("tools/call", { name: "read_me", arguments: {}, _meta });
  assert.equal(tool.resultType, "complete");
  assert.ok(Array.isArray(tool.content));
  assert.match(tool.content[0].text, /Excalidraw Element Format/);
  const discovery = await call("server/discover", { _meta });
  assert.equal(discovery.cacheScope, "private");
  assert.ok(Array.isArray(discovery.supportedVersions));
  assert.ok(discovery.supportedVersions.includes("2026-07-28"));
});

test("legacy stdio initialization and tools remain available", async (t) => {
  const call = start(t);
  const initialized = await call("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" },
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  const tool = await call("tools/call", { name: "read_me", arguments: {} });
  assert.ok(Array.isArray(tool.content));
  assert.match(tool.content[0].text, /Excalidraw Element Format/);
});
