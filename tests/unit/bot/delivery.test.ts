import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createProcessor } from "@/bot/processor.mjs";
import { createPoller } from "@/bot/polling.mjs";
import { createHttpServer, listen, secretMatches } from "@/bot/http.mjs";
import { loadConfig } from "@/bot/config.mjs";
import { MaxApiError } from "@/bot/api.mjs";
import { memoryLogger } from "./helpers";

const started = (userId: number, timestamp: number) => ({
  update_type: "bot_started",
  user: { user_id: userId },
  chat_id: userId,
  timestamp,
});

describe("update processor", () => {
  it("handles each update once (webhook redelivery / polling replay)", async () => {
    const handled: unknown[] = [];
    const { logger } = memoryLogger();
    const processor = createProcessor({ handle: async (u) => void handled.push(u), logger });
    expect(await processor.push(started(1, 100))).toBe(true);
    expect(await processor.push(started(1, 100))).toBe(false);
    expect(await processor.push(started(1, 101))).toBe(true);
    expect(handled).toHaveLength(2);
  });

  it("keeps the order of one user's updates while other users run in parallel", async () => {
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const { logger } = memoryLogger();
    const processor = createProcessor({
      logger,
      handle: async (u: { user?: { user_id?: number | string }; timestamp?: number }) => {
        if (u.timestamp === 1) await firstGate;
        log.push(`${u.user?.user_id}:${u.timestamp}`);
      },
    });
    const a1 = processor.push(started(1, 1));
    const a2 = processor.push(started(1, 2));
    const b1 = processor.push(started(2, 3));
    await b1;
    expect(log).toEqual(["2:3"]);
    releaseFirst();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["2:3", "1:1", "1:2"]);
    expect(processor.pending).toBe(0);
    expect(await processor.drain(100)).toBe(true);
  });

  it("survives handler errors and rejects invalid updates", async () => {
    const { logger, lines } = memoryLogger();
    const processor = createProcessor({
      logger,
      handle: async () => {
        throw new Error("boom");
      },
    });
    expect(await processor.push(started(1, 1))).toBe(true);
    expect(await processor.push(null as never)).toBe(false);
    expect(lines.map((l) => l.msg)).toEqual(["update_failed", "update_invalid"]);
  });
});

describe("long polling", () => {
  it("sends the marker from the previous response and commits only after handling", async () => {
    const requests: (number | null | undefined)[] = [];
    const handled: string[] = [];
    let handledWhenSecondPoll: string[] = [];
    const responses = [
      { updates: [started(1, 1), started(2, 2)], marker: 5 },
      { updates: [], marker: null }, // no new updates: keep the old marker
      { updates: [started(3, 3)], marker: 6 },
    ];
    const { logger } = memoryLogger();
    const ref: { poller?: ReturnType<typeof createPoller> } = {};
    const api = {
      async getUpdates(params: { marker?: number | null }) {
        requests.push(params.marker);
        if (requests.length === 2) handledWhenSecondPoll = [...handled];
        const next = responses.shift();
        if (!next) {
          void ref.poller?.stop();
          throw Object.assign(new Error("stopped"), { name: "AbortError" });
        }
        return next;
      },
    };
    const poller = (ref.poller = createPoller({
      api,
      types: ["bot_started"],
      logger,
      onUpdate: async (u) => {
        await new Promise((r) => setTimeout(r, 5));
        handled.push(String((u as { timestamp?: number }).timestamp));
      },
    }));
    poller.start();
    await new Promise((r) => setTimeout(r, 100));
    await poller.stop();
    expect(requests).toEqual([null, 5, 5, 6]);
    expect(handledWhenSecondPoll).toEqual(["1", "2"]);
    expect(handled).toEqual(["1", "2", "3"]);
    expect(poller.marker).toBe(6);
  });

  it("stops on 401 and reports it", async () => {
    const { logger } = memoryLogger();
    let fatal: unknown;
    const poller = createPoller({
      api: {
        async getUpdates() {
          throw new MaxApiError({
            status: 401,
            code: "verify.token",
            message: "Invalid access_token",
            method: "GET",
            path: "/updates",
          });
        },
      },
      types: [],
      logger,
      onUpdate: async () => {},
      onFatal: (e) => (fatal = e),
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(poller.status.running).toBe(false);
    expect((fatal as MaxApiError).status).toBe(401);
  });

  it("backs off after errors and can be stopped while waiting", async () => {
    const { logger, lines } = memoryLogger();
    let calls = 0;
    const poller = createPoller({
      api: {
        async getUpdates() {
          calls += 1;
          throw new MaxApiError({
            status: 502,
            message: "bad gateway",
            method: "GET",
            path: "/updates",
          });
        },
      },
      types: [],
      logger,
      onUpdate: async () => {},
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    const t = Date.now();
    await poller.stop();
    expect(Date.now() - t).toBeLessThan(500);
    expect(calls).toBe(1);
    expect(lines.find((l) => l.msg === "polling_failed")).toMatchObject({
      delayMs: 1000,
      status: 502,
    });
  });
});

describe("webhook endpoint", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise((r) => server?.close(r) ?? r(undefined));
    server = null;
  });

  async function start(state: "accept" | "not_ready" | "disabled" = "accept") {
    const received: unknown[] = [];
    const { logger, lines } = memoryLogger();
    server = createHttpServer({
      webhookPath: "/max/webhook",
      webhookSecret: "s3cret_value-1",
      webhookState: () => state,
      onUpdate: (u) => received.push(u),
      health: async () => ({ httpStatus: 200, body: { status: "ok" } }),
      logger,
    });
    const port = await listen(server, 0, "127.0.0.1");
    return { base: `http://127.0.0.1:${port}`, received, lines };
  }

  const post = (url: string, body: string, secret?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret !== undefined ? { "X-Max-Bot-Api-Secret": secret } : {}),
      },
      body,
    });

  it("accepts updates with the right secret, answers 200 and processes asynchronously", async () => {
    const { base, received } = await start();
    const res = await post(`${base}/max/webhook`, JSON.stringify(started(1, 1)), "s3cret_value-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([started(1, 1)]);
  });

  it("rejects a wrong or missing secret with 401", async () => {
    const { base, received, lines } = await start();
    expect((await post(`${base}/max/webhook`, "{}", "wrong")).status).toBe(401);
    expect((await post(`${base}/max/webhook`, "{}")).status).toBe(401);
    expect(received).toHaveLength(0);
    expect(lines.filter((l) => l.msg === "webhook_rejected")).toHaveLength(2);
  });

  it("answers 503 while starting so MAX retries later", async () => {
    const { base } = await start("not_ready");
    const res = await post(`${base}/max/webhook`, "{}", "s3cret_value-1");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("is not exposed outside webhook mode", async () => {
    const { base } = await start("disabled");
    expect((await post(`${base}/max/webhook`, "{}", "s3cret_value-1")).status).toBe(404);
  });

  it("validates method, JSON and size", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/max/webhook`)).status).toBe(405);
    expect((await post(`${base}/max/webhook`, "{oops", "s3cret_value-1")).status).toBe(400);
    const big = JSON.stringify({ update_type: "x", pad: "a".repeat(1_100_000) });
    expect((await post(`${base}/max/webhook`, big, "s3cret_value-1")).status).toBe(413);
  });

  it("serves /health and 404 elsewhere", async () => {
    const { base } = await start();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("compares secrets in constant time regardless of length", () => {
    expect(secretMatches("abcde", "abcde")).toBe(true);
    expect(secretMatches("abcd", "abcde")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});

describe("configuration", () => {
  it("runs in disabled mode without a token", () => {
    const c = loadConfig({});
    expect(c.mode).toBe("disabled");
    expect(c.problems).toEqual([]);
    expect(c.port).toBe(8090);
    expect(c.reminders).toBe(false);
    expect(c.apiUrl).toBe("https://platform-api2.max.ru");
  });

  it("defaults to webhook mode when a webhook URL is set, otherwise polling", () => {
    const db = { DATABASE_URL: "postgres://u:p@h/db" };
    expect(loadConfig({ ...db, BOT_TOKEN: "t" }).mode).toBe("polling");
    const c = loadConfig({
      ...db,
      BOT_TOKEN: "t",
      BOT_WEBHOOK_URL: "https://olympus.example.ru/max/webhook",
      BOT_WEBHOOK_SECRET: "abc_DEF-123",
    });
    expect(c.mode).toBe("webhook");
    expect(c.webhookPath).toBe("/max/webhook");
    expect(c.problems).toEqual([]);
  });

  it("reports invalid settings instead of crashing", () => {
    const c = loadConfig({
      BOT_TOKEN: "t",
      BOT_MODE: "webhook",
      BOT_WEBHOOK_URL: "http://example.ru:8443/hook",
      BOT_WEBHOOK_SECRET: "bad secret!",
      BOT_REMINDERS: "maybe",
    });
    expect(c.problems).toEqual(
      expect.arrayContaining([
        "BOT_WEBHOOK_URL must use https://",
        "BOT_WEBHOOK_URL must use port 443 (MAX delivers webhooks only to 443)",
        "BOT_WEBHOOK_SECRET must be 5–256 characters: A-Z a-z 0-9 _ -",
        "BOT_REMINDERS must be on or off",
        "PostgreSQL is not configured: set DATABASE_URL or DB_HOST/DB_USER/DB_NAME",
      ]),
    );
    expect(loadConfig({ BOT_TOKEN: "t", BOT_MODE: "fast" }).problems[0]).toContain("BOT_MODE");
  });

  it("parses reminders and limits", () => {
    const c = loadConfig({
      BOT_REMINDERS: "on",
      BOT_RATE_LIMIT_RPS: "100",
      BOT_REMINDERS_INTERVAL_SECONDS: "5",
      DB_HOST: "postgres",
      DB_USER: "olympus",
      DB_NAME: "olympus",
      DB_SSL: "require",
    });
    expect(c.reminders).toBe(true);
    expect(c.rateLimitRps).toBe(30);
    expect(c.remindersIntervalMs).toBe(30_000);
    expect(c.database).toMatchObject({
      host: "postgres",
      port: 5432,
      ssl: { rejectUnauthorized: false },
    });
  });

  it("can be switched off explicitly", () => {
    expect(loadConfig({ BOT_TOKEN: "t", BOT_MODE: "off" }).mode).toBe("off");
  });
});
