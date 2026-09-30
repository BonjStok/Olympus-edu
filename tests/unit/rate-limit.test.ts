import { describe, expect, it } from "vitest";
import { FailureRateLimiter, loginLimiter } from "@/lib/server/rate-limit";

const MINUTE = 60_000;

function limiter(options: Partial<ConstructorParameters<typeof FailureRateLimiter>[0]> = {}) {
  const clock = { now: 0 };
  const instance = new FailureRateLimiter({
    maxFailures: 3,
    windowMs: 10 * MINUTE,
    blockMs: 5 * MINUTE,
    now: () => clock.now,
    ...options,
  });
  return { clock, instance };
}

describe("FailureRateLimiter", () => {
  it("allows attempts until the failure limit and then blocks with Retry-After", () => {
    const { instance } = limiter();
    expect(instance.check("ip")).toEqual({ allowed: true });
    expect(instance.recordFailure("ip")).toEqual({ allowed: true });
    expect(instance.recordFailure("ip")).toEqual({ allowed: true });
    expect(instance.recordFailure("ip")).toEqual({ allowed: false, retryAfterSeconds: 300 });
    expect(instance.check("ip")).toEqual({ allowed: false, retryAfterSeconds: 300 });
    expect(instance.check("other-ip")).toEqual({ allowed: true });
  });

  it("counts Retry-After down and unblocks after blockMs", () => {
    const { clock, instance } = limiter();
    for (let i = 0; i < 3; i++) instance.recordFailure("ip");
    clock.now = 4 * MINUTE + 30_500;
    expect(instance.check("ip")).toEqual({ allowed: false, retryAfterSeconds: 30 });
    clock.now = 5 * MINUTE;
    expect(instance.check("ip")).toEqual({ allowed: true });
  });

  it("starts a fresh budget after the block and after a quiet window", () => {
    const { clock, instance } = limiter();
    for (let i = 0; i < 3; i++) instance.recordFailure("ip");
    clock.now = 5 * MINUTE;
    expect(instance.recordFailure("ip")).toEqual({ allowed: true });

    const second = limiter();
    second.instance.recordFailure("ip");
    second.instance.recordFailure("ip");
    second.clock.now = 10 * MINUTE;
    expect(second.instance.recordFailure("ip")).toEqual({ allowed: true });
    expect(second.instance.recordFailure("ip")).toEqual({ allowed: true });
    expect(second.instance.recordFailure("ip").allowed).toBe(false);
  });

  it("reset() forgets a key after a successful login", () => {
    const { instance } = limiter();
    instance.recordFailure("ip");
    instance.recordFailure("ip");
    instance.reset("ip");
    instance.recordFailure("ip");
    instance.recordFailure("ip");
    expect(instance.check("ip")).toEqual({ allowed: true });
  });

  it("evicts the least recently seen keys beyond maxKeys", () => {
    const { instance } = limiter({ maxKeys: 2, maxFailures: 2 });
    instance.recordFailure("a");
    instance.recordFailure("b");
    instance.recordFailure("a");
    expect(instance.check("a").allowed).toBe(false);
    instance.recordFailure("c");
    expect(instance.size).toBe(2);
    // "b" was the oldest and is gone: its single failure no longer counts.
    instance.recordFailure("b");
    expect(instance.check("b")).toEqual({ allowed: true });
  });

  it("prunes stale entries on check", () => {
    const { clock, instance } = limiter();
    instance.recordFailure("a");
    instance.recordFailure("b");
    clock.now = 16 * MINUTE;
    instance.check("x");
    expect(instance.size).toBe(0);
  });

  it("clear() empties the limiter", () => {
    const { instance } = limiter();
    instance.recordFailure("a");
    instance.clear();
    expect(instance.size).toBe(0);
  });
});

describe("loginLimiter", () => {
  it("allows ten failed logins per address before blocking for fifteen minutes", () => {
    loginLimiter.clear();
    const key = "198.51.100.1";
    for (let i = 0; i < 9; i++) expect(loginLimiter.recordFailure(key).allowed).toBe(true);
    const decision = loginLimiter.recordFailure(key);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterSeconds).toBe(15 * 60);
    loginLimiter.clear();
  });
});
