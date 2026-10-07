const BODY_LIMITS = new Map<string, { limit: number; mediaType: string }>([
  ["POST /mcp", { limit: 73_728, mediaType: "application/json" }],
  ["POST /register", { limit: 16_384, mediaType: "application/json" }],
  ["POST /token", { limit: 8_192, mediaType: "application/x-www-form-urlencoded" }],
  ["POST /authorize", { limit: 8_192, mediaType: "application/x-www-form-urlencoded" }],
]);
const QUERY_LIMITS = new Map<string, number>([
  ["GET /authorize", 8_192],
  ["GET /callback", 4_096],
]);
const encoder = new TextEncoder();

function failure(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

function rawQuery(requestUrl: string): string {
  const queryStart = requestUrl.indexOf("?");
  if (queryStart < 0) return "";
  const fragmentStart = requestUrl.indexOf("#", queryStart + 1);
  return requestUrl.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(Uint8Array.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function mediaType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export type IngressResult = { kind: "request"; request: Request } | { kind: "response"; response: Response };

export async function enforceIngress(request: Request): Promise<IngressResult> {
  const url = new URL(request.url);
  const route = `${request.method.toUpperCase()} ${url.pathname}`;
  if (request.method.toUpperCase() === "GET" && url.pathname.startsWith("/.well-known/") && request.body !== null) {
    return { kind: "response", response: failure(400) };
  }
  const queryLimit = QUERY_LIMITS.get(route);
  if (queryLimit !== undefined && encoder.encode(rawQuery(request.url)).byteLength > queryLimit) {
    return { kind: "response", response: failure(414) };
  }

  const budget = BODY_LIMITS.get(route);
  if (!budget) return { kind: "request", request };

  const encoding = request.headers.get("Content-Encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    return { kind: "response", response: failure(415) };
  }
  if (mediaType(request.headers.get("Content-Type")) !== budget.mediaType) {
    return { kind: "response", response: failure(415) };
  }

  const rawLength = request.headers.get("Content-Length");
  if (rawLength !== null && /^\d+$/.test(rawLength) && Number(rawLength) > budget.limit) {
    return { kind: "response", response: failure(413) };
  }

  const bytes = await readBoundedBody(request.body, budget.limit);
  if (!bytes) return { kind: "response", response: failure(413) };
  const headers = new Headers(request.headers);
  headers.set("Content-Length", String(bytes.byteLength));
  const bounded = new Request(request.url, {
    method: request.method,
    headers,
    body: bytes.buffer,
    redirect: request.redirect,
  });
  return { kind: "request", request: bounded };
}
