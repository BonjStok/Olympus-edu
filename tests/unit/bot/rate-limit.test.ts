import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "@/bot/rate-limit.mjs";
import { createLogger } from "@/bot/log.mjs";

/** Virtual clock: sleep() advances the virtual time instantly. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("rate limiter", () => {
  it("spaces requests globally at 1000/rps ms (25 rps → 40 ms)", async () => {
    const clock = virtualClock();
    const limiter = createRateLimiter({ rps: 25, chatIntervalMs: 0, ...clock });
    const starts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      starts.push(clock.now());
    }
    expect(starts).toEqual([0, 40, 80, 120, 160]);
  });

  it("never exceeds 30 rps even when configured higher", async () => {
    const clock = virtualClock();
    const limiter = createRateLimiter({ rps: 100, chatIntervalMs: 0, ...clock });
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.now()).toBeCloseTo(1000 / 30, 5);
  });

  it("keeps at least 1 s between messages to the same chat", async () => {
    const clock = virtualClock();
    const limiter = createRateLimiter({ rps: 25, chatIntervalMs: 1000, ...clock });
    await limiter.acquire("user:1");
    const first = clock.now();
    await limiter.acquire("user:1");
    expect(clock.now() - first).toBeGreaterThanOrEqual(1000);
  });

  it("does not delay other chats while one chat waits", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const limiter = createRateLimiter({ rps: 25, chatIntervalMs: 1000 });
      const done: string[] = [];
      await limiter.acquire("user:1");
      const second = limiter.acquire("user:1").then(() => done.push(`user1@${Date.now() - start}`));
      const other = limiter.acquire("user:2").then(() => done.push(`user2@${Date.now() - start}`));
      await vi.advanceTimersByTimeAsync(40);
      expect(done).toEqual(["user2@40"]);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([second, other]);
      expect(done).toEqual(["user2@40", "user1@1000"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("structured logger", () => {
  it("writes one JSON object per line with level and message", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), now: () => 0 });
    log.info("hello", { userId: "42" });
    expect(JSON.parse(lines[0])).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      msg: "hello",
      userId: "42",
    });
  });

  it("filters by level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", write: (l) => lines.push(l) });
    log.info("skip");
    log.warn("keep");
    expect(lines).toHaveLength(1);
  });

  it("redacts secrets and sensitive fields", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), secrets: ["super-secret-token"] });
    log.error("failed", {
      error: "Authorization super-secret-token rejected",
      text: "сообщение ребёнка",
      first_name: "Маша",
      userId: "7",
    });
    const entry = JSON.parse(lines[0]);
    expect(entry.error).toBe("Authorization [redacted] rejected");
    expect(entry.text).toBe("[redacted]");
    expect(entry.first_name).toBe("[redacted]");
    expect(entry.userId).toBe("7");
  });
});
