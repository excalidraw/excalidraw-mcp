import {
  createMcpHandler,
  validateHostHeader,
  originValidationResponse,
  type McpServerFactory,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

export const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const REQUEST_HEADERS = new Set([
  "accept", "content-type", "authorization", "mcp-protocol-version",
  "mcp-method", "mcp-name", "mcp-session-id",
]);

export interface HttpPolicy {
  allowedHosts: string[];
  allowedOrigins: string[];
  maxRequestBytes?: number;
}

function configuredHosts(value: string | undefined): string[] {
  if (!value) return [];
  const hosts = value.split(",").map((host) => host.trim().toLowerCase());
  for (const host of hosts) {
    if (!host || host.includes("*") || !validateHostHeader(host, [host]).ok) {
      throw new Error("Allowed hosts/origins must contain comma-separated hostnames, not URLs or wildcards.");
    }
    const url = new URL(`http://${host}`);
    if (url.port || url.hostname !== host) {
      throw new Error("Allowed hosts/origins must be hostnames without ports.");
    }
  }
  return hosts;
}

export function httpPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): HttpPolicy {
  let allowedHosts = configuredHosts(env.EXCALIDRAW_ALLOWED_HOSTS);
  if (allowedHosts.length === 0 && env.VERCEL) {
    allowedHosts = configuredHosts([
      env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL,
    ].filter(Boolean).join(","));
    if (allowedHosts.length === 0) {
      throw new Error("Set EXCALIDRAW_ALLOWED_HOSTS for the public MCP endpoint.");
    }
  }
  if (allowedHosts.length === 0) {
    const host = env.EXCALIDRAW_HOST ?? "127.0.0.1";
    if (!LOCAL_HOSTS.includes(host)) {
      throw new Error("Network binding requires EXCALIDRAW_ALLOWED_HOSTS.");
    }
    allowedHosts = [...LOCAL_HOSTS];
  }
  const allowedOrigins = configuredHosts(env.EXCALIDRAW_ALLOWED_ORIGINS);
  return { allowedHosts, allowedOrigins: allowedOrigins.length ? allowedOrigins : [...allowedHosts] };
}

function failure(status: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0", id: null, error: { code: -32600, message },
  }, { status });
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", [...REQUEST_HEADERS].join(", "));
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate");
  if (headers.get("Content-Type")?.includes("text/event-stream")) {
    headers.set("X-Accel-Buffering", "no");
  }
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

async function limitedBody(request: Request, limit: number): Promise<ArrayBuffer | null> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("MCP request body is too large");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/** One policy and one per-request SDK factory for both local and serverless HTTP. */
export function createHttpHandler(
  factory: McpServerFactory,
  policy: HttpPolicy = httpPolicyFromEnv(),
): Pick<McpHttpHandler, "fetch" | "close"> {
  const sdk = createMcpHandler(factory, {
    legacy: "stateless",
    responseMode: "auto",
    maxSubscriptions: 0,
    onerror: (error) => console.error("MCP request failed:", error.message),
  });
  const limit = policy.maxRequestBytes ?? MAX_HTTP_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("The HTTP request limit must be a positive byte count.");
  }

  return {
    close: sdk.close,
    fetch: async (request, options) => {
      const url = new URL(request.url);
      const host = validateHostHeader(request.headers.get("host") ?? url.host, policy.allowedHosts);
      if (!host.ok || !validateHostHeader(url.host, policy.allowedHosts).ok) {
        return failure(403, "Host is not allowed.");
      }
      const rejectedOrigin = originValidationResponse(request, policy.allowedOrigins);
      if (rejectedOrigin) return rejectedOrigin;
      const origin = request.headers.get("origin");
      const respond = (response: Response) => withCors(response, origin);
      if (!["/mcp", "/api/mcp"].includes(url.pathname)) {
        return respond(failure(404, "MCP endpoint not found."));
      }
      if (request.method === "OPTIONS") {
        const method = request.headers.get("access-control-request-method");
        const headers = request.headers.get("access-control-request-headers") ?? "";
        if ((method && method !== "POST") ||
          headers.split(",").some((header) => header.trim() && !REQUEST_HEADERS.has(header.trim().toLowerCase()))) {
          return respond(failure(403, "Requested CORS method or headers are not allowed."));
        }
        return respond(new Response(null, { status: 204 }));
      }
      if (request.method !== "POST") {
        const response = failure(405, "Only POST is supported; this endpoint has no MCP sessions.");
        response.headers.set("Allow", "POST, OPTIONS");
        return respond(response);
      }
      const declaredLength = request.headers.get("content-length");
      if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)) {
        return respond(failure(413, `HTTP requests must not exceed ${limit} bytes, including the JSON envelope.`));
      }
      const body = await limitedBody(request, limit);
      if (body === null) {
        return respond(failure(413, `HTTP requests must not exceed ${limit} bytes, including the JSON envelope.`));
      }
      const bounded = new Request(request, { body });
      // Always dispatch the bounded body, not an unverified caller-supplied parsedBody.
      return respond(await sdk.fetch(bounded, { authInfo: options?.authInfo }));
    },
  };
}
