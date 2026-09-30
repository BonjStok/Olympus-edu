import type { Db } from "./db";
import { bearerToken, readCookie } from "./http";
import { randomToken, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "olympus_session";
export const GUEST_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Admin rights of a session lapse after this much time without admin activity (sliding). */
export const ADMIN_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** `admin_seen` is refreshed at most this often to avoid a write on every request. */
const ADMIN_SEEN_REFRESH_MS = 60 * 1000;
/** Current tokens are 64 hex chars; older ones were two UUIDs (72 chars). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type SessionSource = "cookie" | "header";

export interface Session {
  /** Token as the client knows it (cookie or Bearer). It is never stored in the database. */
  token: string;
  /** SHA-256 (hex) of the token: the `sessions.token` column, used for all database access. */
  key: string;
  userId: string;
  name: string | null;
  admin: boolean;
  /**
   * The session had admin rights that lapsed after `ADMIN_IDLE_TIMEOUT_MS` without admin activity:
   * admin actions answer `ADMIN_EXPIRED` (instead of `ADMIN_REQUIRED`) until the next admin login.
   */
  adminExpired: boolean;
  expires: number;
  /** How the client presented the token. Header-authenticated requests skip the Origin check. */
  source: SessionSource;
}

interface SessionRow {
  token: string;
  user_id: string;
  name: string | null;
  admin: number;
  admin_seen: number | null;
  expires: number;
}

/**
 * The token presented by the client. `Authorization: Bearer` wins over the cookie: MAX Web runs the
 * mini-app in a credentialless iframe where cookies do not persist.
 */
export function presentedToken(req: Request): { token: string; source: SessionSource } | null {
  if (req.headers.has("authorization")) {
    const token = bearerToken(req);
    return TOKEN_PATTERN.test(token) ? { token, source: "header" } : null;
  }
  const token = readCookie(req, SESSION_COOKIE);
  return TOKEN_PATTERN.test(token) ? { token, source: "cookie" } : null;
}

/**
 * Database key of a token. Only the SHA-256 of a token is stored, so a database dump or backup
 * cannot be replayed as sessions (migration 0003 hashed the tokens issued before).
 */
export function sessionKey(token: string): Promise<string> {
  return sha256Hex(token);
}

/** True when the request carries an `Authorization` header (valid or not). */
export function usesHeaderAuth(req: Request): boolean {
  return req.headers.has("authorization");
}

export function isGuest(userId: string): boolean {
  return userId.startsWith("guest:");
}

export function isMaxUser(userId: string): boolean {
  return userId.startsWith("max:");
}

export function newGuestUserId(): string {
  return `guest:${crypto.randomUUID()}`;
}

/** Whether an admin flag is still valid at `now` given the last admin activity. */
export function adminActive(adminSeen: number | null, now: number): boolean {
  return adminSeen !== null && now - adminSeen <= ADMIN_IDLE_TIMEOUT_MS;
}

/**
 * Loads the session presented by the request. Admin rights that were idle for longer than
 * `ADMIN_IDLE_TIMEOUT_MS` are not granted (`adminExpired`); active ones slide forward. The lapsed
 * flag stays in the row, so the client learns that the admin session expired (not that it never
 * existed) until `admin-login` or `admin-logout`.
 */
export async function loadSession(db: Db, req: Request, now: number): Promise<Session | null> {
  const presented = presentedToken(req);
  if (!presented) return null;
  const key = await sessionKey(presented.token);
  const row = await db.one<SessionRow>(
    `SELECT token, user_id, name, admin, admin_seen, expires
       FROM sessions WHERE token = $1 AND expires > $2`,
    [key, now],
  );
  if (!row) return null;
  const wasAdmin = Number(row.admin) === 1;
  const seen = row.admin_seen === null ? null : Number(row.admin_seen);
  const admin = wasAdmin && adminActive(seen, now);
  if (admin && now - (seen as number) > ADMIN_SEEN_REFRESH_MS)
    await db.execute("UPDATE sessions SET admin_seen = $2 WHERE token = $1", [key, now]);
  return {
    token: presented.token,
    key,
    userId: row.user_id,
    name: row.name,
    admin,
    adminExpired: wasAdmin && !admin,
    expires: Number(row.expires),
    source: presented.source,
  };
}

export async function createSession(
  db: Db,
  input: { userId: string; name?: string | null; admin?: boolean; expires: number; now: number },
): Promise<Session> {
  const token = randomToken();
  const key = await sessionKey(token);
  await db.execute(
    `INSERT INTO sessions(token, user_id, name, photo, admin, admin_seen, expires)
     VALUES($1, $2, $3, NULL, $4, $5, $6)`,
    [
      key,
      input.userId,
      input.name ?? null,
      input.admin ? 1 : 0,
      input.admin ? input.now : null,
      input.expires,
    ],
  );
  return {
    token,
    key,
    userId: input.userId,
    name: input.name ?? null,
    admin: Boolean(input.admin),
    adminExpired: false,
    expires: input.expires,
    source: "cookie",
  };
}

export async function createGuestSession(db: Db, now: number): Promise<Session> {
  return createSession(db, { userId: newGuestUserId(), expires: now + GUEST_SESSION_TTL_MS, now });
}

/** @param key `Session.key` (hash of the token) */
export async function deleteSession(db: Db, key: string): Promise<void> {
  await db.execute("DELETE FROM sessions WHERE token = $1", [key]);
}

/**
 * Replaces the session token (same user and expiry) with a fresh one and deletes the old token.
 * Used on privilege change so that a token known before admin login is useless afterwards.
 */
export async function rotateSession(
  db: Db,
  session: Session,
  changes: { admin: boolean },
  now: number,
): Promise<Session> {
  return db.transaction(async (tx) => {
    const next = await createSession(tx, {
      userId: session.userId,
      name: session.name,
      admin: changes.admin,
      expires: session.expires,
      now,
    });
    await deleteSession(tx, session.key);
    return next;
  });
}

/** @param key `Session.key` (hash of the token) */
export async function setSessionAdmin(
  db: Db,
  key: string,
  admin: boolean,
  now: number,
): Promise<void> {
  await db.execute("UPDATE sessions SET admin = $2, admin_seen = $3 WHERE token = $1", [
    key,
    admin ? 1 : 0,
    admin ? now : null,
  ]);
}

/**
 * `Set-Cookie` value for the session. Over HTTPS the cookie is `SameSite=None; Partitioned` so it
 * also works when MAX Web embeds the app in a cross-site iframe (CHIPS); plain HTTP (local
 * development) falls back to `SameSite=Lax` because browsers reject `SameSite=None` without Secure.
 */
export function sessionCookie(
  token: string,
  expires: number,
  now: number,
  secure: boolean,
): string {
  const maxAge = Math.max(0, Math.floor((expires - now) / 1000));
  const base = `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly`;
  return secure ? `${base}; Secure; SameSite=None; Partitioned` : `${base}; SameSite=Lax`;
}
