import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMaxApi, MaxApiError, parseRetryAfter } from "@/bot/api.mjs";
import { memoryLogger } from "./helpers";

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** fetch stub answering from a queue of responses (or errors). */
function scriptedFetch(script: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = script.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("MAX API client: requests", () => {
  it("sends the raw token in Authorization (no Bearer) and JSON bodies", async () => {
    const { fetch, calls } = scriptedFetch([json(200, { message: { body: { mid: "m1" } } })]);
    const api = createMaxApi({ token: "secret-token-123", baseUrl: "https://api.test/", fetch });

    const result = await api.sendMessage({ userId: 42 }, { text: "Привет", format: "markdown" });

    expect(result.message.body.mid).toBe("m1");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.test/messages?user_id=42");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("secret-token-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Привет", format: "markdown" });
  });

  it("builds the documented paths and query parameters", async () => {
    const { fetch, calls } = scriptedFetch([
      json(200, { user_id: 1, username: "olympus_bot" }),
      json(200, { success: true }),
      json(200, { updates: [], marker: 7 }),
      json(200, { subscriptions: [] }),
      json(200, { success: true }),
      json(200, { commands: [] }),
    ]);
    const api = createMaxApi({ token: "t0ken-abc", baseUrl: "https://api.test", fetch });

    await api.getMe();
    await api.answerCallback("cb-1", { notification: "ok" });
    await api.getUpdates({ marker: 5, timeout: 20, types: ["bot_started", "message_created"] });
    await api.getSubscriptions();
    await api.subscribe({ url: "https://x.test/max/webhook", secret: "abcde" });
    await api.setCommands([{ name: "start", description: "Начать" }]);

    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET https://api.test/me",
      "POST https://api.test/answers?callback_id=cb-1",
      "GET https://api.test/updates?limit=100&timeout=20&marker=5&types=bot_started%2Cmessage_created",
      "GET https://api.test/subscriptions",
      "POST https://api.test/subscriptions",
      "PATCH https://api.test/me/commands",
    ]);
    expect(JSON.parse(String(calls[5].init.body))).toEqual({
      commands: [{ name: "start", description: "Начать" }],
    });
    // GET requests carry no body and no Content-Type.
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("omits an absent marker so the server returns uncommitted updates", async () => {
    const { fetch, calls } = scriptedFetch([json(200, { updates: [] })]);
    const api = createMaxApi({ token: "t0ken-abc", baseUrl: "https://api.test", fetch });
    await api.getUpdates({ marker: null, timeout: 0 });
    expect(calls[0].url).toBe("https://api.test/updates?limit=100&timeout=0");
  });
});

describe("MAX API client: error mapping", () => {
  it.each([
    [400, "bad_request", false],
    [401, "unauthorized", false],
    [403, "forbidden", false],
    [404, "not_found", false],
  ])("maps HTTP %i to kind %s without retrying", async (status, kind, retryable) => {
    const { fetch, calls } = scriptedFetch([
      json(status, { code: status === 403 ? "chat.denied" : "some.code", message: "nope" }),
    ]);
    const api = createMaxApi({ token: "t0ken-abc", fetch });
    const error = await api.getMe().catch((e) => e);
    expect(error).toBeInstanceOf(MaxApiError);
    expect(error.status).toBe(status);
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
    expect(calls).toHaveLength(1);
  });

  it("keeps the platform error code (e.g. chat.denied) and flags 403 as forbidden", async () => {
    const { fetch } = scriptedFetch([json(403, { code: "chat.denied", message: "denied" })]);
    const api = createMaxApi({ token: "t0ken-abc", fetch });
    const error = await api.sendMessage({ userId: 1 }, { text: "x" }).catch((e) => e);
    expect(error.code).toBe("chat.denied");
    expect(error.forbidden).toBe(true);
    expect(error.message).toContain("403");
  });

  it("tolerates non-JSON error bodies", async () => {
    const { fetch } = scriptedFetch([new Response("<html>bad gateway</html>", { status: 400 })]);
    const api = createMaxApi({ token: "t0ken-abc", fetch });
    const error = await api.getMe().catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("bad gateway");
  });
});

describe("MAX API client: retries with backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries 429 and 5xx with exponential backoff, then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([
      json(429, { code: "too.many.requests", message: "slow down" }),
      json(503, { code: "service.unavailable", message: "later" }),
      json(200, { user_id: 1 }),
    ]);
    const { logger, lines } = memoryLogger();
    const api = createMaxApi({
      token: "t0ken-abc",
      fetch,
      logger,
      baseDelayMs: 1000,
      random: () => 1, // upper bound of the jitter: exactly base·2^attempt
    });

    const promise = api.getMe();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ user_id: 1 });
    expect(calls).toHaveLength(3);
    expect(lines.filter((l) => l.msg === "max_api_retry").map((l) => l.delayMs)).toEqual([
      1000, 2000,
    ]);
  });

  it("honours Retry-After on 429", async () => {
    const { fetch, calls } = scriptedFetch([
      json(429, { code: "limit", message: "wait" }, { "Retry-After": "7" }),
      json(200, { ok: 1 }),
    ]);
    const api = createMaxApi({ token: "t0ken-abc", fetch, baseDelayMs: 10 });
    const promise = api.getMe();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ ok: 1 });
  });

  it("retries network failures and gives up after the retry budget", async () => {
    const netError = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const { fetch, calls } = scriptedFetch([netError, netError, netError]);
    const api = createMaxApi({ token: "t0ken-abc", fetch, retries: 2, baseDelayMs: 100 });
    const promise = api.getMe().catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await promise;
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(MaxApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe("network");
    expect(error.message).toContain("ECONNRESET");
  });

  it("never retries 403 (the user blocked the bot)", async () => {
    const { fetch, calls } = scriptedFetch([json(403, { code: "chat.denied", message: "x" })]);
    const api = createMaxApi({ token: "t0ken-abc", fetch });
    const promise = api.sendMessage({ userId: 5 }, { text: "hi" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await promise).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("caps the backoff delay", async () => {
    const script = Array.from({ length: 6 }, () => json(500, { code: "internal", message: "x" }));
    const { fetch } = scriptedFetch(script);
    const { logger, lines } = memoryLogger();
    const api = createMaxApi({
      token: "t0ken-abc",
      fetch,
      logger,
      retries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      random: () => 1,
    });
    const promise = api.getMe().catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await promise).status).toBe(500);
    expect(lines.filter((l) => l.msg === "max_api_retry").map((l) => l.delayMs)).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
  });
});

describe("MAX API client: misc", () => {
  it("parses Retry-After seconds and HTTP dates, capped at 60 s", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("600")).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const now = Date.UTC(2026, 0, 1);
    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), () => now)).toBe(5000);
  });

  it("requires a token", () => {
    expect(() => createMaxApi({ token: "" })).toThrow(/BOT_TOKEN/);
  });

  it("logs retries without the token or the request body", async () => {
    const { fetch } = scriptedFetch([
      json(500, { code: "x", message: "echo secret-token-xyz" }),
      json(200, {}),
    ]);
    const { logger, lines } = memoryLogger();
    const api = createMaxApi({ token: "secret-token-xyz", fetch, logger, baseDelayMs: 1 });
    await api.sendMessage({ userId: 9 }, { text: "личное сообщение" });
    expect(lines.map((l) => l.msg)).toEqual(["max_api_retry"]);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("secret-token-xyz");
    expect(serialized).not.toContain("личное");
  });
});
