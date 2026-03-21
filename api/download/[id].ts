import { createVercelPngStore } from "../../src/png-store.js";

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

  const entry = await store.load(id);
  if (!entry) {
    return new Response(JSON.stringify({ error: "Not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  await store.delete(id);

  return new Response(entry.data, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${entry.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
