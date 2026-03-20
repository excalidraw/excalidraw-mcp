import { createMcpHandler } from "mcp-handler";
import path from "node:path";
import { createVercelStore } from "../src/checkpoint-store.js";
import { createVercelPngStore } from "../src/png-store.js";
import { registerTools } from "../src/server.js";

const store = createVercelStore();
const pngStore = createVercelPngStore();

const baseUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3001";

const mcpHandler = createMcpHandler(
  (server) => {
    const distDir = path.join(process.cwd(), "dist");
    registerTools(server, distDir, store, { pngStore, baseUrl });
  },
  { serverInfo: { name: "Excalidraw", version: "1.0.0" } },
  { basePath: "", maxDuration: 60, sessionIdGenerator: undefined },
);

// Wrap to support both /mcp and /api/mcp (backward compat)
const handler = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.replace("/api/", "/");
    return mcpHandler(new Request(url.toString(), request));
  }
  return mcpHandler(request);
};

export { handler as GET, handler as POST, handler as DELETE };
