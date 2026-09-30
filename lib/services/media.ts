// Media uploaded by admins (R2 bucket binding `BUCKET`; local R2 emulation in Docker).
import { ApiError, unavailable, unprocessable } from "@/lib/server/errors";
import type { MediaBucket, ServerEnv } from "@/lib/server/env";

export const UPLOAD_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "video/mp4",
] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
export const MEDIA_ID_PATTERN = /^[a-f0-9-]{20,64}$/i;

const tooLarge = () => new ApiError(413, "FILE_TOO_LARGE", "Файл слишком большой: максимум 8 МБ");
const invalidFile = () =>
  unprocessable("Файл повреждён или не совпадает с выбранным типом", "INVALID_FILE");

export function isUploadType(value: unknown): value is UploadType {
  return typeof value === "string" && (UPLOAD_TYPES as readonly string[]).includes(value);
}

/** Strict base64 decoding (whitespace is ignored). Throws 422 `INVALID_FILE` on garbage. */
export function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, "");
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    throw invalidFile();
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    throw invalidFile();
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** Checks the file signature so that e.g. HTML cannot be uploaded as "image/png". */
export function matchesFileType(type: UploadType, bytes: Uint8Array): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-"));
    case "video/mp4":
      return startsWith(bytes, ascii("ftyp"), 4);
  }
}

function requireBucket(env: Pick<ServerEnv, "BUCKET">): MediaBucket {
  if (!env.BUCKET)
    throw unavailable("Загрузка файлов недоступна: хранилище не подключено", "STORAGE_UNAVAILABLE");
  return env.BUCKET;
}

export interface UploadResult {
  url: string;
  id: string;
  type: UploadType;
  size: number;
}

export async function uploadMedia(
  env: Pick<ServerEnv, "BUCKET">,
  body: Record<string, unknown>,
  now: number,
): Promise<UploadResult> {
  const bucket = requireBucket(env);
  if (!isUploadType(body.type))
    throw new ApiError(415, "UNSUPPORTED_FILE_TYPE", "Поддерживаются PNG, JPG, WebP, PDF и MP4");
  if (typeof body.base64 !== "string") throw invalidFile();
  if (body.base64.length > MAX_BASE64_LENGTH + 1024) throw tooLarge();
  const bytes = decodeBase64(body.base64);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw tooLarge();
  if (!matchesFileType(body.type, bytes)) throw invalidFile();
  const id = crypto.randomUUID();
  await bucket.put(id, bytes, {
    httpMetadata: { contentType: body.type },
    customMetadata: { uploadedAt: new Date(now).toISOString() },
  });
  return { url: `/api/media/${id}`, id, type: body.type, size: bytes.byteLength };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `Range: bytes=...` header against the object size. Returns null when the range
 * cannot be satisfied (the caller answers 416).
 */
export function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Math.min(Number(match[2]), size);
    if (suffix <= 0) return null;
    start = size - suffix;
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return null;
  return { start, end };
}

const MEDIA_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Accept-Ranges": "bytes",
};

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: {
      ...MEDIA_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function contentType(value: string | undefined): string {
  return isUploadType(value) ? value : "application/octet-stream";
}

/** `GET /api/media/:id` with single-range support for video seeking. */
export async function serveMedia(
  env: Pick<ServerEnv, "BUCKET">,
  req: Request,
  id: string,
): Promise<Response> {
  if (!MEDIA_ID_PATTERN.test(id)) return plain(404, "Не найдено");
  if (!env.BUCKET) return plain(503, "Хранилище файлов недоступно");
  const bucket = env.BUCKET;
  const cacheHeaders = {
    ...MEDIA_HEADERS,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": "inline",
  };

  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const head = await bucket.head(id);
    if (!head) return plain(404, "Не найдено");
    const range = parseRange(rangeHeader, head.size);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { ...MEDIA_HEADERS, "Content-Range": `bytes */${head.size}` },
      });
    const length = range.end - range.start + 1;
    const object = await bucket.get(id, { range: { offset: range.start, length } });
    if (!object) return plain(404, "Не найдено");
    return new Response(object.body, {
      status: 206,
      headers: {
        ...cacheHeaders,
        "Content-Type": contentType(
          object.httpMetadata?.contentType ?? head.httpMetadata?.contentType,
        ),
        "Content-Length": String(length),
        "Content-Range": `bytes ${range.start}-${range.end}/${head.size}`,
        ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
      },
    });
  }

  const object = await bucket.get(id);
  if (!object) return plain(404, "Не найдено");
  return new Response(object.body, {
    headers: {
      ...cacheHeaders,
      "Content-Type": contentType(object.httpMetadata?.contentType),
      "Content-Length": String(object.size),
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    },
  });
}
