import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import type { MediaBucket, MediaObject, MediaObjectHead } from "@/lib/server/env";
import {
  decodeBase64,
  isUploadType,
  matchesFileType,
  MAX_UPLOAD_BYTES,
  parseRange,
  serveMedia,
  uploadMedia,
  UPLOAD_TYPES,
} from "@/lib/services/media";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const ascii = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const WEBP = ascii("RIFF\0\0\0\0WEBPVP8 ");
const PDF = ascii("%PDF-1.7\n");
const MP4 = ascii("\0\0\0\x18ftypisom");
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

class Bucket implements MediaBucket {
  objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: value, type: options?.httpMetadata?.contentType });
  }
  async head(key: string): Promise<MediaObjectHead | null> {
    const object = this.objects.get(key);
    return object
      ? { size: object.bytes.length, httpMetadata: { contentType: object.type }, httpEtag: '"e"' }
      : null;
  }
  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<MediaObject | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = options?.range
      ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : object.bytes;
    return {
      size: object.bytes.length,
      httpEtag: '"e"',
      httpMetadata: { contentType: object.type },
      body: new Response(bytes as BodyInit).body,
    };
  }
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect(caught).toMatchObject({ status, code });
}

describe("decodeBase64", () => {
  it("decodes valid base64 and ignores whitespace", () => {
    expect(decodeBase64(toBase64(PNG))).toEqual(PNG);
    expect(decodeBase64("aGVs\nbG8=\n")).toEqual(ascii("hello"));
  });

  it.each([[""], ["aGVsbG8"], ["aGV*bG8="], ["aGVsbG8==="], ["=aGVsbG8"]])(
    "rejects %j with 422 INVALID_FILE",
    (value) => {
      expect(() => decodeBase64(value)).toThrow(ApiError);
      try {
        decodeBase64(value);
      } catch (error) {
        expect(error).toMatchObject({ status: 422, code: "INVALID_FILE" });
      }
    },
  );
});

describe("file signatures", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/webp", WEBP],
    ["application/pdf", PDF],
    ["video/mp4", MP4],
  ] as const)("%s matches its own signature only", (type, bytes) => {
    expect(matchesFileType(type, bytes)).toBe(true);
    for (const other of UPLOAD_TYPES.filter((t) => t !== type))
      expect(matchesFileType(other, bytes)).toBe(false);
  });

  it("rejects HTML pretending to be an image", () => {
    expect(matchesFileType("image/png", ascii("<html><script>"))).toBe(false);
  });

  it("knows the allowed types", () => {
    expect(isUploadType("image/png")).toBe(true);
    expect(isUploadType("text/html")).toBe(false);
    expect(isUploadType(undefined)).toBe(false);
  });
});

describe("parseRange", () => {
  it.each([
    ["bytes=0-99", 1000, { start: 0, end: 99 }],
    ["bytes=500-", 1000, { start: 500, end: 999 }],
    ["bytes=-100", 1000, { start: 900, end: 999 }],
    ["bytes=-5000", 1000, { start: 0, end: 999 }],
    ["bytes=900-5000", 1000, { start: 900, end: 999 }],
    [" bytes=1-1 ", 10, { start: 1, end: 1 }],
  ])("%s of %i bytes", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each([
    ["bytes=-", 1000],
    ["bytes=5-2", 1000],
    ["bytes=1000-", 1000],
    ["bytes=-0", 1000],
    ["bytes=0-1,5-6", 1000],
    ["items=0-1", 1000],
    ["bytes=0-1", 0],
  ])("%s of %i bytes is unsatisfiable", (header, size) => {
    expect(parseRange(header, size)).toBeNull();
  });
});

describe("uploadMedia", () => {
  it("stores a valid file and returns its public URL", async () => {
    const bucket = new Bucket();
    const result = await uploadMedia(
      { BUCKET: bucket },
      { type: "image/png", base64: toBase64(PNG) },
      0,
    );
    expect(result).toEqual({
      url: `/api/media/${result.id}`,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: "image/png",
      size: PNG.length,
    });
    expect(bucket.objects.get(result.id)).toEqual({ bytes: PNG, type: "image/png" });
  });

  it("needs storage", async () => {
    await expectApiError(
      uploadMedia({ BUCKET: null }, { type: "image/png", base64: "" }, 0),
      503,
      "STORAGE_UNAVAILABLE",
    );
  });

  it("rejects unsupported types with 415", async () => {
    await expectApiError(
      uploadMedia(
        { BUCKET: new Bucket() },
        { type: "text/html", base64: toBase64(ascii("<b>")) },
        0,
      ),
      415,
      "UNSUPPORTED_FILE_TYPE",
    );
  });

  it("rejects missing data and signature mismatches with 422", async () => {
    await expectApiError(
      uploadMedia({ BUCKET: new Bucket() }, { type: "image/png" }, 0),
      422,
      "INVALID_FILE",
    );
    await expectApiError(
      uploadMedia({ BUCKET: new Bucket() }, { type: "image/png", base64: toBase64(JPEG) }, 0),
      422,
      "INVALID_FILE",
    );
  });

  it("rejects files over 8 MB with 413, before and after decoding", async () => {
    const bucket = new Bucket();
    await expectApiError(
      uploadMedia(
        { BUCKET: bucket },
        { type: "application/pdf", base64: "A".repeat(12_000_000) },
        0,
      ),
      413,
      "FILE_TOO_LARGE",
    );
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PDF);
    await expectApiError(
      uploadMedia({ BUCKET: bucket }, { type: "application/pdf", base64: toBase64(big) }, 0),
      413,
      "FILE_TOO_LARGE",
    );
    expect(bucket.objects.size).toBe(0);
  });
});

describe("serveMedia", () => {
  const id = "0b3c5d0e-1111-2222-3333-444455556666";
  const withFile = (type?: string) => {
    const bucket = new Bucket();
    bucket.objects.set(id, { bytes: ascii("0123456789"), type });
    return bucket;
  };
  const request = (headers: Record<string, string> = {}) =>
    new Request(`http://localhost/api/media/${id}`, { headers });

  it("answers 404 for ids that cannot exist and 503 without storage", async () => {
    expect((await serveMedia({ BUCKET: withFile() }, request(), "../etc")).status).toBe(404);
    expect((await serveMedia({ BUCKET: null }, request(), id)).status).toBe(503);
    expect((await serveMedia({ BUCKET: new Bucket() }, request(), id)).status).toBe(404);
    expect(
      (await serveMedia({ BUCKET: new Bucket() }, request({ range: "bytes=0-1" }), id)).status,
    ).toBe(404);
  });

  it("serves the whole file with safe caching headers", async () => {
    const response = await serveMedia({ BUCKET: withFile("image/png") }, request(), id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe('"e"');
  });

  it("never serves a stored type outside the allow-list", async () => {
    const response = await serveMedia({ BUCKET: withFile("text/html") }, request(), id);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("serves byte ranges for video seeking", async () => {
    const response = await serveMedia(
      { BUCKET: withFile("video/mp4") },
      request({ range: "bytes=2-5" }),
      id,
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("etag")).toBe('"e"');
  });

  it("answers 416 for an unsatisfiable range", async () => {
    const response = await serveMedia(
      { BUCKET: withFile("video/mp4") },
      request({ range: "bytes=20-" }),
      id,
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });
});
