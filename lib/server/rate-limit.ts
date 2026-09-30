export interface RateLimitOptions {
  /** Failures allowed inside `windowMs` before the key is blocked. */
  maxFailures: number;
  windowMs: number;
  blockMs: number;
  /** Upper bound of tracked keys; the oldest entries are dropped first. */
  maxKeys?: number;
  now?: () => number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Entry {
  failures: number;
  windowStart: number;
  blockedUntil: number;
  lastSeen: number;
}

/**
 * Counts failed attempts (e.g. wrong passwords) per key in a fixed window and blocks the key for
 * `blockMs` once the limit is reached. State is in memory, per server process: enough for a single
 * web container; a multi-instance deployment would need a shared store.
 */
export class FailureRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(key);
    if (entry && entry.blockedUntil > now)
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    return { allowed: true };
  }

  recordFailure(key: string): RateLimitDecision {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.options.windowMs) {
      entry = { failures: 0, windowStart: now, blockedUntil: 0, lastSeen: now };
    }
    entry.failures += 1;
    entry.lastSeen = now;
    if (entry.failures >= this.options.maxFailures) {
      entry.blockedUntil = now + this.options.blockMs;
      entry.failures = 0;
      entry.windowStart = entry.blockedUntil;
    }
    // Re-insert to keep Map order = least recently seen first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return this.check(key);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number) {
    const ttl = this.options.windowMs + this.options.blockMs;
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.lastSeen > ttl) this.entries.delete(key);
    }
  }
}

/**
 * One limiter for every password login (admin panel and `/api/v1/auth/login`), keyed by client IP:
 * failures on either endpoint count against the same budget.
 */
export const loginLimiter = new FailureRateLimiter({
  maxFailures: 10,
  windowMs: 15 * 60_000,
  blockMs: 15 * 60_000,
});

export const LOGIN_RATE_LIMIT_MESSAGE = "Слишком много попыток входа. Попробуйте позже";
