import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, OPTIONS, PATCH, POST, PUT } from "@/app/api/olympus/route";
import type { BootstrapResponse } from "@/lib/domain/types";
import { FIXTURE_RECORDS, FX } from "../support/fixtures";
import {
  adminToken,
  BY_TOKEN,
  bootstrap,
  configureEnv,
  guestToken,
  ORIGIN,
  publishedBundleIds,
  resetDatabase,
  rpc,
  signInitData,
  sql,
} from "../support/server";

const [n1] = FX.numbers;
const [lesson1] = FX.mathLessons;

beforeAll(() => resetDatabase({ fixtures: true }));
beforeEach(() => configureEnv());

describe("GET /api/olympus (bootstrap)", () => {
  it("starts a guest session with a cookie and returns its token in the body", async () => {
    const response = await bootstrap<BootstrapResponse>(GET);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(
      /^olympus_session=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/,
    );
    expect(cookie).toContain(response.body.sessionToken);
    expect(response.body.profile).toEqual({ name: null, photo: null, max: false, admin: false });
    expect(response.body.features).toEqual({
      runner: false,
      max: true,
      reminders: false,
      botName: null,
    });
    expect(response.body.runner).toBe(false);
    expect(response.body.maxConnected).toBe(true);
    // The catalogue is the published content bundle plus the published test fixtures.
    const ids = response.body.records.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [...publishedBundleIds(), ...FIXTURE_RECORDS.map((record) => record.id)].sort(),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Server clock for mock timers: in the body and in the Date header.
    expect(Math.abs(response.body.serverTime - Date.now())).toBeLessThan(5_000);
    const date = Date.parse(response.headers.get("date") ?? "");
    expect(Math.abs(date - response.body.serverTime)).toBeLessThan(2_000);
  });

  it("stores only the SHA-256 of the session token", async () => {
    const response = await bootstrap<BootstrapResponse>(GET);
    const token = response.body.sessionToken;
    expect(await sql("SELECT 1 FROM sessions WHERE token = $1", [token])).toHaveLength(0);
    expect(await sql(`SELECT 1 FROM sessions WHERE token = ${BY_TOKEN}`, [token])).toHaveLength(1);
    // A stolen key (e.g. from a backup) is not a usable token.
    const [{ key }] = await sql<{ key: string }>(`SELECT ${BY_TOKEN} AS key`, [token]);
    const replay = await bootstrap<BootstrapResponse>(GET, { token: key });
    expect(replay.body.sessionToken).not.toBe(token);
    expect(replay.body.sessionToken).not.toBe(key);
  });

  it("uses Secure; SameSite=None; Partitioned behind an HTTPS proxy", async () => {
    const response = await bootstrap(
      GET,
      {},
      { "x-forwarded-proto": "https", host: "olymp.example" },
    );
    expect(response.headers.get("set-cookie")).toMatch(
      /HttpOnly; Secure; SameSite=None; Partitioned$/,
    );
  });

  it("reuses the session from the cookie or the Authorization header without a new cookie", async () => {
    const token = await guestToken(POST);
    const viaCookie = await bootstrap<BootstrapResponse>(GET, { token, cookie: true });
    const viaHeader = await bootstrap<BootstrapResponse>(GET, { token });
    for (const response of [viaCookie, viaHeader]) {
      expect(response.body.sessionToken).toBe(token);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("replaces an unknown token with a new guest session", async () => {
    const response = await bootstrap<BootstrapResponse>(GET, { token: "f".repeat(64) });
    expect(response.body.sessionToken).not.toBe("f".repeat(64));
    expect(response.headers.get("set-cookie")).toContain(response.body.sessionToken);
  });

  it("hides lesson and task bodies from children and never returns drafts", async () => {
    const response = await bootstrap<BootstrapResponse>(GET);
    const task = response.body.records.find((record) => record.kind === "tasks");
    expect(task).toBeDefined();
    expect(Object.keys(task!).sort()).toEqual(
      ["grade", "id", "kind", "order", "points", "subject", "title", "topicId", "type"].sort(),
    );
    const lesson = response.body.records.find((record) => record.kind === "lessons");
    expect(lesson).not.toHaveProperty("blocks");
  });

  it("reports the bot name for MAX links", async () => {
    configureEnv({ MAX_BOT_NAME: "id1234567890_bot" });
    expect((await bootstrap<BootstrapResponse>(GET)).body.features.botName).toBe(
      "id1234567890_bot",
    );
    configureEnv({ MAX_BOT_NAME: undefined });
  });

  it("reports features from the environment", async () => {
    configureEnv({ RUNNER_URL: "http://runner:8080", BOT_TOKEN: "", BOT_REMINDERS: "off" });
    const response = await bootstrap<BootstrapResponse>(GET);
    expect(response.body.features).toEqual({
      runner: true,
      max: false,
      reminders: false,
      botName: null,
    });
    configureEnv({ BOT_REMINDERS: "off" });
    expect((await bootstrap<BootstrapResponse>(GET)).body.features.reminders).toBe(false);
    configureEnv({ BOT_REMINDERS: "on" });
    expect((await bootstrap<BootstrapResponse>(GET)).body.features).toEqual({
      runner: false,
      max: true,
      reminders: true,
      botName: null,
    });
  });

  it("answers 503 with a generic message when the database is unreachable", async () => {
    const url = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/none";
    try {
      const response = await bootstrap(GET);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: expect.stringMatching(/База данных/),
        code: "DATABASE_UNAVAILABLE",
      });
    } finally {
      process.env.DATABASE_URL = url;
    }
  });
});

describe("action session", () => {
  it("creates a guest session once and then returns the same token", async () => {
    const first = await rpc<{ ok: boolean; sessionToken: string }>(POST, "session");
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.headers.get("set-cookie")).toContain(first.body.sessionToken);
    const again = await rpc<{ sessionToken: string }>(
      POST,
      "session",
      {},
      {
        token: first.body.sessionToken,
        cookie: true,
      },
    );
    expect(again.body.sessionToken).toBe(first.body.sessionToken);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("signs in with MAX initData, returns startParam and merges guest progress", async () => {
    const guest = await guestToken(POST);
    await rpc(POST, "view-lesson", { id: lesson1 }, { token: guest });
    await rpc(POST, "settings", { region: "Республика Алтай", grade: 5 }, { token: guest });
    const initData = await signInitData({
      user: { id: 777000111, first_name: "Маша", last_name: "Иванова", username: "masha" },
      extra: { start_param: `mock_${FX.mocks.math.id}` },
    });

    const signedIn = await rpc<{ sessionToken: string; startParam?: string }>(
      POST,
      "session",
      { initData },
      { token: guest },
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.startParam).toBe(`mock_${FX.mocks.math.id}`);
    expect(signedIn.body.sessionToken).not.toBe(guest);

    const me = await bootstrap<BootstrapResponse>(GET, { token: signedIn.body.sessionToken });
    expect(me.body.profile).toEqual({ name: "Маша Иванова", photo: null, max: true, admin: false });
    expect(me.body.progress[`lesson:${lesson1}`]).toEqual({ read: true });
    expect(me.body.progress.settings).toEqual({ region: "Республика Алтай", grade: 5 });

    const leftovers = await sql(`SELECT user_id FROM sessions WHERE token = ${BY_TOKEN}`, [guest]);
    expect(leftovers).toHaveLength(0);
    const rows = await sql<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM progress WHERE user_id LIKE 'guest:%' AND key = $1",
      [`lesson:${lesson1}`],
    );
    expect(rows).toHaveLength(0);
  });

  it("merges into an existing MAX account: achievements OR-ed, newer settings win", async () => {
    const maxInit = await signInitData({ user: { id: 555, first_name: "Петя" } });
    const first = await rpc<{ sessionToken: string }>(POST, "session", { initData: maxInit });
    const maxToken = first.body.sessionToken;
    await rpc(POST, "settings", { grade: 4, subject: "math" }, { token: maxToken });
    const wrong = await rpc(POST, "check", { id: n1.id, answer: "0" }, { token: maxToken });
    expect(wrong.body).toMatchObject({ correct: false });

    const guest = await guestToken(POST);
    const right = await rpc(POST, "check", { id: n1.id, answer: n1.answer }, { token: guest });
    expect(right.body).toMatchObject({ correct: true });
    await rpc(POST, "settings", { grade: 6 }, { token: guest });
    const second = await rpc<{ sessionToken: string }>(
      POST,
      "session",
      { initData: await signInitData({ user: { id: 555, first_name: "Петя" } }) },
      { token: guest },
    );
    const me = await bootstrap<BootstrapResponse>(GET, { token: second.body.sessionToken });
    expect(me.body.progress[`task:${n1.id}`]).toMatchObject({ correct: true, attempts: 1 });
    expect(me.body.progress.settings).toEqual({ grade: 6, subject: "math" });
  });

  it("revokes the previous non-guest token when signing in again", async () => {
    const init = await signInitData({ user: { id: 9001, first_name: "Оля" } });
    const first = await rpc<{ sessionToken: string }>(POST, "session", { initData: init });
    const second = await rpc<{ sessionToken: string }>(
      POST,
      "session",
      { initData: init },
      { token: first.body.sessionToken },
    );
    expect(second.status).toBe(200);
    expect(
      await sql(`SELECT 1 FROM sessions WHERE token = ${BY_TOKEN}`, [first.body.sessionToken]),
    ).toHaveLength(0);
  });

  it.each([
    [
      "a tampered signature",
      // Always a different digit: replacing it with "0" kept a hash that already began with 0.
      async () =>
        (await signInitData()).replace(
          /hash=([0-9a-f])/,
          (_m, c) => `hash=${c === "0" ? "1" : "0"}`,
        ),
      401,
      "MAX_AUTH_FAILED",
    ],
    ["a foreign bot token", () => signInitData({ botToken: "other-bot" }), 401, "MAX_AUTH_FAILED"],
    [
      "expired data",
      () => signInitData({ authDate: Math.floor(Date.now() / 1000) - 7200 }),
      401,
      "MAX_AUTH_FAILED",
    ],
    ["a duplicate key", async () => `${await signInitData()}&auth_date=1`, 400, "MAX_AUTH_FAILED"],
    ["a non-string value", async () => 12345 as unknown as string, 400, "MAX_AUTH_FAILED"],
  ])("rejects %s", async (_name, make, status, code) => {
    const response = await rpc(POST, "session", { initData: await make() });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: expect.any(String), code });
  });

  it("answers 503 MAX_NOT_CONFIGURED without BOT_TOKEN", async () => {
    configureEnv({ BOT_TOKEN: "" });
    const response = await rpc(POST, "session", { initData: "auth_date=1&hash=00" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("MAX_NOT_CONFIGURED");
  });
});

describe("admin login", () => {
  it("rotates the token, keeps the user and grants admin rights", async () => {
    const guest = await guestToken(POST);
    const login = await rpc<{ ok: boolean; sessionToken: string }>(
      POST,
      "admin-login",
      { password: "admin-password-for-tests" },
      { token: guest },
    );
    expect(login.status).toBe(200);
    expect(login.body.sessionToken).not.toBe(guest);
    expect(login.headers.get("set-cookie")).toContain(login.body.sessionToken);
    expect((await bootstrap<BootstrapResponse>(GET, { token: guest })).body.profile.admin).toBe(
      false,
    );
    const me = await bootstrap<BootstrapResponse>(GET, { token: login.body.sessionToken });
    expect(me.body.profile.admin).toBe(true);
    expect(me.body.records[0]).toHaveProperty("draft");
  });

  it("rejects a wrong password with 403 and then rate-limits by X-Real-IP", async () => {
    const guest = await guestToken(POST);
    let last;
    for (let i = 0; i < 10; i++)
      last = await rpc(
        POST,
        "admin-login",
        { password: "nope" },
        { token: guest },
        { "x-real-ip": "10.0.0.7" },
      );
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toMatch(/^\d+$/);
    const first = await rpc(
      POST,
      "admin-login",
      { password: "nope" },
      { token: guest },
      { "x-real-ip": "10.0.0.8" },
    );
    expect(first.status).toBe(403);
    expect(first.body.code).toBe("WRONG_PASSWORD");
    // Even the right password is refused while the address is blocked.
    const blocked = await rpc(
      POST,
      "admin-login",
      { password: "admin-password-for-tests" },
      { token: guest },
      { "x-real-ip": "10.0.0.7" },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");
  });

  it("does not trust spoofable forwarding headers for the limiter", async () => {
    const guest = await guestToken(POST);
    let last;
    for (let i = 0; i < 10; i++)
      last = await rpc(
        POST,
        "admin-login",
        { password: "nope" },
        { token: guest },
        { "x-forwarded-for": `203.0.113.${i}`, "cf-connecting-ip": `198.51.100.${i}` },
      );
    expect(last!.status).toBe(429);
  });

  it("answers 503 when no admin password is configured", async () => {
    configureEnv({ ADMIN_PASSWORD: "" });
    const guest = await guestToken(POST);
    const response = await rpc(POST, "admin-login", { password: "x" }, { token: guest });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("ADMIN_NOT_CONFIGURED");
  });

  it("drops admin rights after an hour without admin activity and on logout", async () => {
    const token = await adminToken(POST);
    await sql(`UPDATE sessions SET admin_seen = $2 WHERE token = ${BY_TOKEN}`, [
      token,
      Date.now() - 61 * 60_000,
    ]);
    const expired = await rpc(POST, "deleted", {}, { token });
    expect(expired.status).toBe(403);
    // The client is told that the teacher mode closed after a break (not that it never existed).
    expect(expired.body.code).toBe("ADMIN_EXPIRED");
    expect((await rpc(POST, "deleted", {}, { token })).body.code).toBe("ADMIN_EXPIRED");
    const view = await bootstrap<BootstrapResponse>(GET, { token });
    expect(view.body.profile.admin).toBe(false);
    expect(view.body.records.some((record) => "draft" in record)).toBe(false);
    // Nothing slides an expired admin session back: only a new admin-login does.
    const [stale] = await sql<{ admin_seen: string }>(
      `SELECT admin_seen FROM sessions WHERE token = ${BY_TOKEN}`,
      [token],
    );
    expect(Date.now() - Number(stale.admin_seen)).toBeGreaterThan(60 * 60_000);

    const fresh = await adminToken(POST);
    await sql(`UPDATE sessions SET admin_seen = $2 WHERE token = ${BY_TOKEN}`, [
      fresh,
      Date.now() - 30 * 60_000,
    ]);
    expect((await rpc(POST, "deleted", {}, { token: fresh })).status).toBe(200);
    const [row] = await sql<{ admin_seen: string }>(
      `SELECT admin_seen FROM sessions WHERE token = ${BY_TOKEN}`,
      [fresh],
    );
    expect(Date.now() - Number(row.admin_seen)).toBeLessThan(60_000);

    expect((await rpc(POST, "admin-logout", {}, { token: fresh })).status).toBe(200);
    const loggedOut = await rpc(POST, "deleted", {}, { token: fresh });
    expect(loggedOut).toMatchObject({ status: 403, body: { code: "ADMIN_REQUIRED" } });
  });

  it("requires a session for admin login", async () => {
    const response = await rpc(POST, "admin-login", { password: "x" });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("SESSION_EXPIRED");
  });
});

describe("origin and transport checks", () => {
  it("accepts signed MAX login data from the Android MAX container origin", async () => {
    const response = await rpc(
      POST,
      "session",
      { initData: await signInitData({ user: { id: 777, first_name: "Аня" } }) },
      {},
      { origin: "https://web.max.ru" },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
  });

  it("rejects cookie-authenticated requests from a foreign origin", async () => {
    const token = await guestToken(POST);
    const response = await rpc(
      POST,
      "view-lesson",
      { id: lesson1 },
      { token, cookie: true },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("BAD_ORIGIN");
  });

  it("allows header-authenticated requests from any origin (no ambient credentials)", async () => {
    const token = await guestToken(POST);
    const response = await rpc(
      POST,
      "view-lesson",
      { id: lesson1 },
      { token },
      { origin: "https://web.max.ru" },
    );
    expect(response.status).toBe(200);
  });

  it("accepts the origin announced by the reverse proxy", async () => {
    const response = await rpc(
      POST,
      "session",
      {},
      {},
      {
        origin: "https://olymp.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "olymp.example",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Partitioned");
  });

  it("answers other methods with 405 in the error format", async () => {
    for (const handler of [PUT, PATCH, DELETE, OPTIONS]) {
      const response = await handler();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST");
      expect(await response.json()).toEqual({
        error: "Используйте GET или POST",
        code: "METHOD_NOT_ALLOWED",
      });
    }
  });

  it("requires JSON", async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/olympus`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: ORIGIN },
        body: JSON.stringify({ action: "session" }),
      }),
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it.each([
    ["invalid JSON", "{", 400, "INVALID_JSON"],
    ["a JSON array", "[]", 400, "INVALID_REQUEST"],
    ["an unknown action", JSON.stringify({ action: "drop-tables" }), 400, "UNKNOWN_ACTION"],
    ["a missing action", JSON.stringify({}), 400, "UNKNOWN_ACTION"],
    ["an inherited property name", JSON.stringify({ action: "toString" }), 400, "UNKNOWN_ACTION"],
  ])("rejects %s", async (_name, body, status, code) => {
    const response = await POST(
      new Request(`${ORIGIN}/api/olympus`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
      }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });

  it("limits the body size to 256 KB for regular users", async () => {
    const token = await guestToken(POST);
    const response = await rpc(
      POST,
      "code-draft",
      { id: FX.code[0].id, code: "x".repeat(300_000) },
      { token },
    );
    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("requires a session for regular actions", async () => {
    const response = await rpc(POST, "view-lesson", { id: lesson1 });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: expect.stringMatching(/Обнови/),
      code: "SESSION_EXPIRED",
    });
  });
});
