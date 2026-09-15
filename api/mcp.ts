import path from "node:path";
import { createVercelStore } from "../src/checkpoint-store.js";
import { createHttpHandler } from "../src/http.js";
import { createServer } from "../src/server.js";

const store = createVercelStore();
const handler = createHttpHandler(() => createServer(store, path.join(process.cwd(), "dist")));

export const maxDuration = 60;
export const GET = handler.fetch;
export const POST = handler.fetch;
export const DELETE = handler.fetch;
export const OPTIONS = handler.fetch;
