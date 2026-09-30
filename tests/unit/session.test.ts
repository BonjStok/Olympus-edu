import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db, SqlValue } from "@/lib/server/db";
import { GUEST_SESSION_TTL_MS as SCRIPT_GUEST_SESSION_TTL_MS } from "../../scripts/seed.mjs";
import {
  ADMIN_IDLE_TIMEOUT_MS,
  adminActive,
  createGuestSession,
  GUEST_SESSION_TTL_MS,
  isGuest,
  isMaxUser,
  loadSession,
  newGuestUserId,
  presentedToken,
  rotateSession,
  sessionCookie,
  sessionKey,
  usesHeaderAuth,
  type Session,
} from "@/lib/server/session";

const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);
/** The database stores SHA-256 of the token (computed independently of the app here). */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const KEY = sha256(TOKEN);
const NOW = 10_000_000_000;

const req = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

/** Records statements and answers `one()` with a canned session row. */
class FakeDb implements Db {
  statements: Array<{ sql: string; params: readonly SqlValue[] }> = [];
  transactions = 0;
  constructor(private readonly row: Record<string, unknown> | null = null) {}
  async query<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    this.statements.push({ sql, params });
    return (this.row ? [this.row] : []) as Row[];
  }
  async one<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row | null> {
    return (await this.query<Row>(sql, params))[0] ?? null;
  }
  async execute(sql: string, params: readonly SqlValue[] = []): Promise<number> {
    this.statements.push({ sql, params });
    return 1;
  }
  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }
  updates() {
    return this.statements.filter((s) => /^\s*(UPDATE|INSERT|DELETE)/.test(s.sql));
  }
}

const row = (extra: Record<string, unknown> = {}) => ({
  token: KEY,
  user_id: "guest:1",
  name: null,
  admin: 0,
  admin_seen: null,
  expires: String(NOW + 1000),
  ...extra,
});

describe("presentedToken", () => {
  it("prefers the Authorization header over the cookie", () => {
    expect(
      presentedToken(req({ authorization: `Bearer ${TOKEN}`, cookie: `olympus_session=${OTHER}` })),
    ).toEqual({
      token: TOKEN,
      source: "header",
    });
  });

  it("falls back to the cookie", () => {
    expect(presentedToken(req({ cookie: `olympus_session=${OTHER}` }))).toEqual({
      token: OTHER,
      source: "cookie",
    });
  });

  it("does not fall back to the cookie when the header is present but invalid", () => {
    expect(
      presentedToken(req({ authorization: "Bearer short", cookie: `olympus_session=${OTHER}` })),
    ).toBeNull();
    expect(usesHeaderAuth(req({ authorization: "Bearer short" }))).toBe(true);
    expect(usesHeaderAuth(req({ cookie: "x=1" }))).toBe(false);
  });

  it.each([["x".repeat(31)], ["x".repeat(129)], ["a'; DROP TABLE sessions;--" + "a".repeat(20)]])(
    "rejects malformed token %j",
    (token) => {
      expect(presentedToken(req({ cookie: `olympus_session=${token}` }))).toBeNull();
    },
  );

  it("accepts legacy tokens made of two UUIDs", () => {
    const legacy = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    expect(presentedToken(req({ cookie: `olympus_session=${legacy}` }))?.token).toBe(legacy);
  });
});

describe("user ids", () => {
  it("classifies guests and MAX users", () => {
    const guest = newGuestUserId();
    expect(guest).toMatch(/^guest:[0-9a-f-]{36}$/);
    expect(isGuest(guest)).toBe(true);
    expect(isMaxUser(guest)).toBe(false);
    expect(isMaxUser("max:123")).toBe(true);
    expect(isGuest("test:evaluator")).toBe(false);
  });
});

describe("guest session lifetime", () => {
  it("is the same in the app and in the cleanup script", () => {
    expect(SCRIPT_GUEST_SESSION_TTL_MS).toBe(GUEST_SESSION_TTL_MS);
  });
});

describe("sessionKey", () => {
  it("is the hex SHA-256 of the token", async () => {
    expect(await sessionKey(TOKEN)).toBe(KEY);
    expect(await sessionKey(OTHER)).not.toBe(KEY);
  });
});

describe("sessionCookie", () => {
  it("is partitioned and cross-site capable over HTTPS", () => {
    expect(sessionCookie(TOKEN, NOW + 3_600_500, NOW, true)).toBe(
      `olympus_session=${TOKEN}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  });

  it("uses SameSite=Lax without Secure over plain HTTP", () => {
    expect(sessionCookie(TOKEN, NOW + 60_000, NOW, false)).toBe(
      `olympus_session=${TOKEN}; Path=/; Max-Age=60; HttpOnly; SameSite=Lax`,
    );
  });

  it("never produces a negative Max-Age", () => {
    expect(sessionCookie(TOKEN, NOW - 1, NOW, false)).toContain("Max-Age=0;");
  });
});

describe("admin idle timeout", () => {
  it.each([
    [null, false],
    [NOW, true],
    [NOW - ADMIN_IDLE_TIMEOUT_MS, true],
    [NOW - ADMIN_IDLE_TIMEOUT_MS - 1, false],
  ])("admin_seen %s → active %s", (seen, expected) => {
    expect(adminActive(seen, NOW)).toBe(expected);
  });
});

describe("loadSession", () => {
  const withToken = req({ authorization: `Bearer ${TOKEN}` });

  it("returns null without a usable token or row, without querying for bad tokens", async () => {
    const db = new FakeDb(row());
    expect(await loadSession(db, req({}), NOW)).toBeNull();
    expect(db.statements).toHaveLength(0);
    expect(await loadSession(new FakeDb(null), withToken, NOW)).toBeNull();
  });

  it("loads a regular session and passes the current time to the expiry check", async () => {
    const db = new FakeDb(row({ name: "Маша", user_id: "max:1" }));
    expect(await loadSession(db, withToken, NOW)).toEqual<Session>({
      token: TOKEN,
      key: KEY,
      userId: "max:1",
      name: "Маша",
      admin: false,
      adminExpired: false,
      expires: NOW + 1000,
      source: "header",
    });
    // Looked up by the hash: the raw token never reaches the database.
    expect(db.statements[0].params).toEqual([KEY, NOW]);
    expect(db.updates()).toHaveLength(0);
  });

  it("keeps recent admin rights without a write", async () => {
    const db = new FakeDb(row({ admin: 1, admin_seen: String(NOW - 30_000) }));
    expect((await loadSession(db, withToken, NOW))?.admin).toBe(true);
    expect(db.updates()).toHaveLength(0);
  });

  it("slides admin_seen forward after a minute of activity", async () => {
    const db = new FakeDb(row({ admin: 1, admin_seen: NOW - 5 * 60_000 }));
    expect((await loadSession(db, withToken, NOW))?.admin).toBe(true);
    expect(db.updates()).toEqual([
      { sql: "UPDATE sessions SET admin_seen = $2 WHERE token = $1", params: [KEY, NOW] },
    ]);
  });

  it.each([[null], [NOW - ADMIN_IDLE_TIMEOUT_MS - 1]])(
    "does not grant idle or legacy admin rights and reports them as expired (admin_seen %s)",
    async (seen) => {
      const db = new FakeDb(row({ admin: 1, admin_seen: seen }));
      expect(await loadSession(db, withToken, NOW)).toMatchObject({
        admin: false,
        adminExpired: true,
      });
      expect(db.updates()).toHaveLength(0);
    },
  );
});

describe("session creation and rotation", () => {
  it("creates a guest session valid for a year with a fresh random token", async () => {
    const db = new FakeDb();
    const first = await createGuestSession(db, NOW);
    const second = await createGuestSession(db, NOW);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.token).not.toBe(second.token);
    expect(first).toMatchObject({
      admin: false,
      adminExpired: false,
      expires: NOW + GUEST_SESSION_TTL_MS,
    });
    expect(first.key).toBe(sha256(first.token));
    expect(db.statements[0].params).toEqual([
      first.key,
      first.userId,
      null,
      0,
      null,
      first.expires,
    ]);
  });

  it("rotation issues a new admin token for the same user and deletes the old one atomically", async () => {
    const db = new FakeDb();
    const old: Session = {
      token: TOKEN,
      key: KEY,
      userId: "guest:1",
      name: null,
      admin: false,
      adminExpired: false,
      expires: NOW + 5,
      source: "cookie",
    };
    const next = await rotateSession(db, old, { admin: true }, NOW);
    expect(db.transactions).toBe(1);
    expect(next).toMatchObject({ userId: "guest:1", admin: true, expires: NOW + 5 });
    expect(next.token).not.toBe(TOKEN);
    const [insert, remove] = db.updates();
    expect(insert.params).toEqual([sha256(next.token), "guest:1", null, 1, NOW, NOW + 5]);
    expect(remove).toEqual({ sql: "DELETE FROM sessions WHERE token = $1", params: [KEY] });
  });
});
