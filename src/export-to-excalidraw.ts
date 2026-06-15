function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
  let total = 4;
  for (const b of bufs) total += 4 + b.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1);
  let off = 4;
  for (const b of bufs) {
    dv.setUint32(off, b.length);
    off += 4;
    out.set(b, off);
    off += b.length;
  }
  return out;
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new TypeError("CompressionStream is not available in this environment");
  }
  const bytes = new Uint8Array(data);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Upload serialized Excalidraw JSON and return a shareable excalidraw.com URL. */
export async function exportJsonToExcalidrawUrl(json: string): Promise<string> {
  const te = new TextEncoder();
  const fileMetadata = te.encode(JSON.stringify({}));
  const dataBytes = te.encode(json);
  const innerPayload = concatBuffers(fileMetadata, dataBytes);
  const compressed = new Uint8Array(await deflateZlib(innerPayload));

  const cryptoKey = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    true,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    compressed,
  );

  const encodingMeta = te.encode(JSON.stringify({
    version: 2,
    compression: "pako@1",
    encryption: "AES-GCM",
  }));
  const payload = concatBuffers(encodingMeta, iv, new Uint8Array(encrypted));
  const body = new Uint8Array(payload);

  const res = await fetch("https://json.excalidraw.com/api/v2/post/", {
    method: "POST",
    body,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };

  const jwk = await globalThis.crypto.subtle.exportKey("jwk", cryptoKey);
  return `https://excalidraw.com/#json=${id},${jwk.k}`;
}
