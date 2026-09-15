import { toNodeHandler } from "@modelcontextprotocol/node";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/express";
import { type McpServerFactory } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer as createHttpServer } from "node:http";
import express, { type ErrorRequestHandler, type Express } from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileCheckpointStore } from "./checkpoint-store.js";
import { createHttpHandler, httpPolicyFromEnv, MAX_HTTP_BYTES } from "./http.js";
import { createServer } from "./server.js";

function httpFailureDetails(type: unknown): { status: number; code: number; message: string } {
  switch (type) {
    case "entity.too.large":
      return { status: 413, code: -32600, message: `HTTP requests must not exceed ${MAX_HTTP_BYTES} bytes.` };
    case "entity.parse.failed":
      return { status: 400, code: -32700, message: "Request body must be valid JSON." };
    default:
      return { status: 500, code: -32603, message: "Internal server error." };
  }
}

export function createLocalHttpApp(
  factory: McpServerFactory, policy = httpPolicyFromEnv(),
): { app: Express; handler: ReturnType<typeof createHttpHandler> } {
  const handler = createHttpHandler(factory, policy);
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => console.error("MCP HTTP error:", error.message),
  });
  const app = express();
  app.use(hostHeaderValidation(policy.allowedHosts), originValidation(policy.allowedOrigins));
  app.use((req, res, next) => {
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
    }
    next();
  });
  // Bound the stream before the Node adapter buffers it; the SDK validates JSON-RPC shape.
  app.use(express.json({ limit: policy.maxRequestBytes ?? MAX_HTTP_BYTES, strict: false }));
  app.use((req, res, next) => {
    if (req.method === "POST" && !req.is("application/json")) {
      res.status(415).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Content-Type must be application/json." } });
      return;
    }
    void nodeHandler(req, res, req.body).catch(next);
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
    const { status, code, message } = httpFailureDetails(type);
    if (status === 500) console.error("MCP HTTP failure:", error);
    res.status(status).json({ jsonrpc: "2.0", id: null, error: { code, message } });
  };
  app.use(errors);
  return { app, handler };
}

export async function main(): Promise<void> {
  const store = new FileCheckpointStore();
  const factory = () => createServer(store);
  if (process.argv.includes("--stdio")) {
    const handle = serveStdio(factory, {
      legacy: "serve",
      onerror: (error) => console.error("MCP stdio error:", error.message),
    });
    const shutdown = () => {
      handle.close().catch((error: unknown) => {
        console.error("MCP shutdown failed:", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  const port = Number(process.env.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const host = process.env.EXCALIDRAW_HOST ?? "127.0.0.1";
  const { app, handler } = createLocalHttpApp(factory);
  const server = createHttpServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      accept();
    });
  });
  console.error(`MCP server listening on http://${host}:${port}/mcp`);

  const shutdown = () => {
    server.close();
    void handler.close().then(() => server.closeAllConnections()).catch((error: unknown) => {
      console.error("MCP shutdown failed:", error);
      server.closeAllConnections();
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
