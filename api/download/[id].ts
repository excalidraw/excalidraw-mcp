import { createVercelPngStore, RedisPngStore } from "../../src/png-store.js";

const store = createVercelPngStore();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.pathname.split("/").pop();
  if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
    return new Response(JSON.stringify({ error: "Invalid ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Redis store needs async load
  const entry = store instanceof RedisPngStore
    ? await store.loadAsync(id)
    : store.load(id);

  if (!entry) {
    return new Response(JSON.stringify({ error: "Not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  store.delete(id);

  return new Response(entry.data, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${entry.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
