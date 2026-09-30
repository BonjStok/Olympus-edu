import { ApiError, badRequest } from "./errors";

/** Headers added to every API response. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

/**
 * JSON response with the security headers. `Date` is set explicitly (workerd does not add it) so
 * that the client can compare its clock with the server's.
 */
export function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return jsonTextResponse(JSON.stringify(data), status, headers);
}

/** Same as `jsonResponse` for a body that is already serialised JSON. */
export function jsonTextResponse(json: string, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(API_SECURITY_HEADERS);
  merged.set("Content-Type", "application/json; charset=utf-8");
  merged.set("Date", new Date().toUTCString());
  new Headers(headers).forEach((value, key) => merged.append(key, value));
  return new Response(json, { status, headers: merged });
}

// ---------------------------------------------------------------------------
// Request metadata
// ---------------------------------------------------------------------------

export function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

/** Token from `Authorization: Bearer <token>`, or "" when the header is absent or malformed. */
export function bearerToken(req: Request): string {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return match ? match[1] : "";
}

/**
 * Client address used for rate limiting. Only `X-Real-IP` is trusted: in production Caddy
 * overwrites it with the TCP peer address (see Caddyfile), while `X-Forwarded-For` and
 * `CF-Connecting-IP` can be forged by the client and are ignored.
 */
export function clientIp(req: Request): string {
  const value = (req.headers.get("x-real-ip") ?? "").trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value.toLowerCase() : "unknown";
}

function firstHeaderValue(req: Request, name: string): string {
  return (req.headers.get(name) ?? "").split(",")[0].trim();
}

/** Public origin of the request as seen by the browser (honours the reverse proxy headers). */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = firstHeaderValue(req, "x-forwarded-proto").toLowerCase();
  const host = firstHeaderValue(req, "x-forwarded-host") || firstHeaderValue(req, "host");
  const scheme = proto === "https" || proto === "http" ? proto : url.protocol.replace(":", "");
  return host ? `${scheme}://${host}` : url.origin;
}

export function isSecureRequest(req: Request): boolean {
  return requestOrigin(req).startsWith("https://");
}

/**
 * CSRF protection for cookie-authenticated mutations: a browser always sends `Origin` on
 * cross-site POST requests, so a present-but-foreign origin is rejected.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  // No Origin: a non-browser client or a same-origin navigation. "null" (opaque) never matches.
  if (origin === null) return true;
  return origin === requestOrigin(req);
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

export const DEFAULT_BODY_LIMIT = 256 * 1024;
/** Mock answers: up to 20 programs of 50 000 characters each must still fit. */
export const MOCK_BODY_LIMIT = 2 * 1024 * 1024;
/** Admin imports and uploads (8 MB file as base64). */
export const LARGE_BODY_LIMIT = 12 * 1024 * 1024;

export interface ReadJsonOptions {
  maxBytes?: number;
  /** Accept a request without a body (returns `undefined`). */
  optional?: boolean;
}

export interface JsonBody {
  value: unknown;
  bytes: number;
}

const payloadTooLarge = () =>
  new ApiError(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос. Уменьшите размер данных");

export function isJsonContentType(req: Request): boolean {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/**
 * Reads and parses a JSON body without buffering more than `maxBytes`: the declared
 * Content-Length is checked first, then the stream is counted while it is read.
 */
export async function readJsonBody(req: Request, options: ReadJsonOptions = {}): Promise<JsonBody> {
  const { maxBytes = DEFAULT_BODY_LIMIT, optional = false } = options;
  const declared = req.headers.get("content-length");
  const hasBody = req.body !== null && declared !== "0";
  if (!hasBody) {
    if (optional) return { value: undefined, bytes: 0 };
    throw badRequest("Нужно передать JSON в теле запроса", "INVALID_JSON");
  }
  if (!isJsonContentType(req)) {
    if (optional && !req.headers.get("content-type")) {
      await req.body?.cancel().catch(() => undefined);
      return { value: undefined, bytes: 0 };
    }
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Используйте Content-Type: application/json");
  }
  if (declared !== null && Number(declared) > maxBytes) throw payloadTooLarge();

  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw payloadTooLarge();
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(buffer);
  if (!text.trim()) {
    if (optional) return { value: undefined, bytes };
    throw badRequest("Нужно передать JSON в теле запроса", "INVALID_JSON");
  }
  try {
    return { value: JSON.parse(text) as unknown, bytes };
  } catch {
    throw badRequest("Некорректный JSON в теле запроса", "INVALID_JSON");
  }
}
