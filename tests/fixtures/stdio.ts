import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MemoryCheckpointStore } from "../../src/checkpoint-store.js";
import { createServer } from "../../src/server.js";

const store = new MemoryCheckpointStore();
serveStdio(() => createServer(store));
