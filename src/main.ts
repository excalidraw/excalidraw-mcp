/**
 * Entry point for running the MCP server.
 * Run with: npx @mcp-demos/excalidraw-server
 * Or: node dist/index.js [--stdio]
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { FileCheckpointStore } from "./checkpoint-store.js";
import { MemoryPngStore } from "./png-store.js";
import { createServer } from "./server.js";

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 *
 * @param createServer - Factory function that creates a new McpServer instance per request.
 */
export async function startStreamableHTTPServer(
  createServer: () => McpServer,
  pngStore: MemoryPngStore,
): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  // PNG download endpoint — serves stored PNGs as file downloads
  app.get("/download/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const entry = pngStore.load(id);
    if (!entry) {
      res.status(404).json({ error: "Not found or expired" });
      return;
    }
    pngStore.delete(id);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);
    res.send(entry.data);
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, (err) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.log(`MCP server listening on http://localhost:${port}/mcp`);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Starts an MCP server with stdio transport.
 *
 * @param createServer - Factory function that creates a new McpServer instance.
 */
export async function startStdioServer(
  createServer: () => McpServer,
): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

async function main() {
  const store = new FileCheckpointStore();
  const pngStore = new MemoryPngStore();

  if (process.argv.includes("--stdio")) {
    // stdio mode: no HTTP server, save_png falls back to ~/Downloads
    const factory = () => createServer(store);
    await startStdioServer(factory);
  } else {
    const port = parseInt(process.env.PORT ?? "3001", 10);
    const baseUrl = `http://localhost:${port}`;
    const factory = () => createServer(store, { pngStore, baseUrl });
    await startStreamableHTTPServer(factory, pngStore);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
