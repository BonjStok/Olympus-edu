import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import {
  bearerToken,
  clientIp,
  DEFAULT_BODY_LIMIT,
  isJsonContentType,
  isSameOrigin,
  isSecureRequest,
  jsonResponse,
  readCookie,
  readJsonBody,
  requestOrigin,
} from "@/lib/server/http";

const req = (headers: Record<string, string> = {}, url = "http://localhost/api/olympus") =>
  new Request(url, { headers });

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/olympus", {
    method: "POST",
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected an ApiError");
}

describe("jsonResponse", () => {
  it("adds JSON and security headers and keeps extra headers", async () => {
    const response = jsonResponse({ ok: true }, 201, { "Set-Cookie": "a=b", "Retry-After": "3" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "set-cookie": "a=b",
      "retry-after": "3",
    });
    expect(response.headers.has("x-frame-options")).toBe(false);
  });

  it("always carries the server clock in the Date header", () => {
    const before = Date.now();
    const date = Date.parse(jsonResponse({}).headers.get("date") ?? "");
    expect(date).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(date).toBeLessThanOrEqual(Date.now());
  });
});

describe("request metadata", () => {
  it("reads a cookie by exact name", () => {
    const request = req({ cookie: "other=1; olympus_session_old=x;  olympus_session=abc=def ; z" });
    expect(readCookie(request, "olympus_session")).toBe("abc=def");
    expect(readCookie(request, "missing")).toBe("");
    expect(readCookie(req(), "olympus_session")).toBe("");
  });

  it.each([
    ["Bearer abc123", "abc123"],
    ["bearer   abc123  ", "abc123"],
    ["Basic abc123", ""],
    ["Bearer", ""],
    ["Bearer a b", ""],
  ])("bearerToken(%j) → %j", (header, expected) => {
    expect(bearerToken(req({ authorization: header }))).toBe(expected);
  });

  it("trusts only X-Real-IP for the client address", () => {
    expect(clientIp(req({ "x-real-ip": " 203.0.113.7 " }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-real-ip": "2001:DB8::1" }))).toBe("2001:db8::1");
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" }))).toBe(
      "unknown",
    );
    expect(clientIp(req({ "x-real-ip": "evil<script>" }))).toBe("unknown");
    expect(clientIp(req({ "x-real-ip": "1".repeat(46) }))).toBe("unknown");
  });

  it.each([
    [{}, "http://localhost"],
    [{ host: "olymp.example" }, "http://olymp.example"],
    [{ "x-forwarded-proto": "https", host: "olymp.example" }, "https://olymp.example"],
    [
      {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "a.example, b.example",
        host: "web:3000",
      },
      "https://a.example",
    ],
    [{ "x-forwarded-proto": "gopher", host: "olymp.example" }, "http://olymp.example"],
  ])("requestOrigin with %j → %s", (headers, expected) => {
    expect(requestOrigin(req(headers))).toBe(expected);
  });

  it("detects HTTPS directly or behind the proxy", () => {
    expect(isSecureRequest(req({}, "https://olymp.example/api"))).toBe(true);
    expect(isSecureRequest(req({ "x-forwarded-proto": "https", host: "x" }))).toBe(true);
    expect(isSecureRequest(req())).toBe(false);
  });

  it("accepts a missing or matching Origin and rejects foreign or opaque ones", () => {
    expect(isSameOrigin(req())).toBe(true);
    expect(isSameOrigin(req({ origin: "http://localhost" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "null" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "" }))).toBe(false);
    expect(
      isSameOrigin(
        req({
          origin: "https://olymp.example",
          "x-forwarded-proto": "https",
          host: "olymp.example",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["application/json", true],
    ["Application/JSON; charset=utf-8", true],
    ["application/merge-patch+json", true],
    ["text/plain", false],
    ["application/x-www-form-urlencoded", false],
    ["", false],
  ])("isJsonContentType(%j) → %s", (type, expected) => {
    expect(isJsonContentType(req(type ? { "content-type": type } : {}))).toBe(expected);
  });
});

describe("readJsonBody", () => {
  const json = { "content-type": "application/json" };

  it("parses JSON and reports the byte count", async () => {
    const body = JSON.stringify({ name: "Маша" });
    expect(await readJsonBody(post(body, json))).toEqual({
      value: { name: "Маша" },
      bytes: new TextEncoder().encode(body).length,
    });
  });

  it("rejects a declared Content-Length over the limit before reading the stream", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const error = await caught(
      readJsonBody(post(stream, { ...json, "content-length": "1000" }), { maxBytes: 10 }),
    );
    expect(error).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(pulled).toBe(false);
  });

  it("stops reading a streamed body that exceeds the limit", async () => {
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024).fill(32));
        if (chunks > 1000) controller.close();
      },
    });
    const error = await caught(readJsonBody(post(stream, json), { maxBytes: 4096 }));
    expect(error).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(chunks).toBeLessThan(10);
  });

  it("uses a 256 KB default limit", async () => {
    const body = JSON.stringify({ code: "x".repeat(DEFAULT_BODY_LIMIT) });
    expect((await caught(readJsonBody(post(body, json)))).status).toBe(413);
  });

  it("rejects invalid JSON with 400", async () => {
    expect(await caught(readJsonBody(post("{oops", json)))).toMatchObject({
      status: 400,
      code: "INVALID_JSON",
    });
  });

  it("requires a body unless it is optional", async () => {
    expect((await caught(readJsonBody(post(null, json)))).code).toBe("INVALID_JSON");
    expect((await caught(readJsonBody(post("   ", json)))).code).toBe("INVALID_JSON");
    expect(await readJsonBody(post(null, json), { optional: true })).toEqual({
      value: undefined,
      bytes: 0,
    });
    expect(await readJsonBody(post("  ", json), { optional: true })).toEqual({
      value: undefined,
      bytes: 2,
    });
    expect(
      await readJsonBody(post("{}", { ...json, "content-length": "0" }), { optional: true }),
    ).toEqual({
      value: undefined,
      bytes: 0,
    });
  });

  it("requires application/json when a body is sent", async () => {
    expect(await caught(readJsonBody(post("{}", { "content-type": "text/plain" })))).toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    expect(
      (await caught(readJsonBody(post("{}", { "content-type": "text/plain" }), { optional: true })))
        .status,
    ).toBe(415);
  });

  it("ignores an optional body sent without any content type", async () => {
    const request = new Request("http://localhost/x", {
      method: "POST",
      body: new Uint8Array([123, 125]),
    });
    expect(await readJsonBody(request, { optional: true })).toEqual({ value: undefined, bytes: 0 });
  });
});
