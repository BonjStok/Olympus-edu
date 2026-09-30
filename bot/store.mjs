// @ts-check
/**
 * PostgreSQL access for the bot.
 * - Read-only: app tables `records` and `progress` (schema: drizzle/0000_*.sql).
 * - Read/write: `bot_users`, `bot_reminders` (drizzle/0002_bot.sql).
 * The MAX user `<id>` is `progress.user_id = 'max:<id>'` in the app.
 */

import { Pool } from "pg";
import { normalizeMockTest, normalizeOlympiad } from "./olympiads.mjs";

/** @typedef {import("./olympiads.mjs").Olympiad} Olympiad */
/** @typedef {import("./olympiads.mjs").MockTest} MockTest */
/** @typedef {import("./progress.mjs").ProgressRow} ProgressRow */

/**
 * @typedef {object} BotUser
 * @property {string} userId
 * @property {string | null} firstName
 * @property {number | null} startedAt
 * @property {number | null} stoppedAt
 * @property {boolean} remindersEnabled
 */

/**
 * A registration of an opted-in user, joined with the olympiad record.
 * @typedef {object} ReminderCandidate
 * @property {string} userId
 * @property {unknown} registration `registration:<id>` progress value
 * @property {unknown} olympiad raw olympiad record
 * @property {unknown} settings the user's app settings (may be null)
 */

/**
 * @typedef {{ query<Row = any>(text: string, values?: unknown[]): Promise<{ rows: Row[], rowCount: number | null }> }} Queryable
 */

/** App user id for a MAX user id. @param {string | number} userId */
export const appUserId = (userId) => `max:${userId}`;

/**
 * @param {unknown} text
 */
function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {any} row
 * @returns {BotUser}
 */
function toUser(row) {
  return {
    userId: String(row.user_id),
    firstName: row.first_name ?? null,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    stoppedAt: row.stopped_at == null ? null : Number(row.stopped_at),
    remindersEnabled: Boolean(row.reminders_enabled),
  };
}

/**
 * @param {Record<string, unknown>} config pg connection config
 * @param {(error: Error) => void} [onError]
 */
export function createPool(config, onError) {
  const pool = new Pool(config);
  // An idle client losing its connection must not crash the process.
  /** @type {any} */ (pool).on("error", (/** @type {Error} */ error) => onError?.(error));
  return pool;
}

/**
 * @param {Queryable} db
 * @param {{ now?: () => number, cacheMs?: number }} [options] `now` stamps stored rows;
 *   the content cache always expires by real time.
 */
export function createStore(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? 60_000;
  /** @type {Map<string, { at: number, value: Promise<any[]> }>} */
  const cache = new Map();

  /**
   * Published records of one kind, cached briefly (content changes rarely).
   * @param {"olympiads" | "mock-tests"} kind
   */
  function records(kind) {
    const hit = cache.get(kind);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value;
    const value = db
      .query("SELECT data FROM records WHERE kind = $1 AND deleted = 0", [kind])
      .then((r) => r.rows.map((row) => parseJson(row.data)));
    value.catch(() => cache.delete(kind));
    cache.set(kind, { at: Date.now(), value });
    return value;
  }

  const upsertSql = `
    INSERT INTO bot_users (user_id, first_name, started_at, stopped_at, reminders_enabled, updated)
    VALUES ($1, $2, $3, NULL, FALSE, $4)
    ON CONFLICT (user_id) DO UPDATE SET
      first_name = COALESCE(EXCLUDED.first_name, bot_users.first_name),
      started_at = COALESCE($3, bot_users.started_at),
      stopped_at = NULL,
      updated = EXCLUDED.updated
    RETURNING *`;

  return {
    /** Tables of the bot exist (migration 0002 applied) and the app tables are readable. */
    async checkSchema() {
      const r = await db.query(
        `SELECT to_regclass('public.bot_users') IS NOT NULL AS users,
                to_regclass('public.bot_reminders') IS NOT NULL AS reminders,
                to_regclass('public.progress') IS NOT NULL AS progress,
                to_regclass('public.records') IS NOT NULL AS records`,
      );
      const row = r.rows[0] ?? {};
      return Boolean(row.users && row.reminders && row.progress && row.records);
    },

    /**
     * `bot_started`: (re)start the dialog. Reminders stay as they were before the stop
     * (a stop always switches them off).
     * @param {string} userId
     * @param {string | null} firstName
     * @returns {Promise<BotUser>}
     */
    async startUser(userId, firstName) {
      const t = now();
      const r = await db.query(upsertSql, [userId, firstName, t, t]);
      return toUser(r.rows[0]);
    },

    /**
     * Any message or button press from the user: they are active again.
     * @param {string} userId
     * @param {string | null} firstName
     * @returns {Promise<BotUser>}
     */
    async touchUser(userId, firstName) {
      const r = await db.query(upsertSql, [userId, firstName, null, now()]);
      return toUser(r.rows[0]);
    },

    /**
     * `bot_stopped` / `bot_removed` / `dialog_removed` / 403 from the API.
     * @param {string} userId
     */
    async markStopped(userId) {
      const t = now();
      await db.query(
        `INSERT INTO bot_users (user_id, stopped_at, reminders_enabled, updated)
         VALUES ($1, $2, FALSE, $2)
         ON CONFLICT (user_id) DO UPDATE SET stopped_at = $2, reminders_enabled = FALSE, updated = $2`,
        [userId, t],
      );
    },

    /**
     * @param {string} userId
     * @param {boolean} enabled
     * @returns {Promise<BotUser>}
     */
    async setReminders(userId, enabled) {
      const t = now();
      const r = await db.query(
        `INSERT INTO bot_users (user_id, started_at, reminders_enabled, updated)
         VALUES ($1, $3, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET reminders_enabled = $2, stopped_at = NULL, updated = $3
         RETURNING *`,
        [userId, enabled, t],
      );
      return toUser(r.rows[0]);
    },

    /**
     * @param {string} userId
     * @returns {Promise<BotUser | null>}
     */
    async getUser(userId) {
      const r = await db.query("SELECT * FROM bot_users WHERE user_id = $1", [userId]);
      return r.rows[0] ? toUser(r.rows[0]) : null;
    },

    /**
     * All progress rows of the MAX user in the app.
     * @param {string} userId
     * @returns {Promise<ProgressRow[]>}
     */
    async loadProgress(userId) {
      const r = await db.query("SELECT key, data FROM progress WHERE user_id = $1", [
        appUserId(userId),
      ]);
      return r.rows.map((row) => ({ key: String(row.key), data: parseJson(row.data) }));
    },

    /** @returns {Promise<Olympiad[]>} */
    async loadOlympiads() {
      const rows = await records("olympiads");
      return rows.map(normalizeOlympiad).filter(/** @returns {o is Olympiad} */ (o) => !!o);
    },

    /** @returns {Promise<MockTest[]>} */
    async loadMockTests() {
      const rows = await records("mock-tests");
      return rows.map(normalizeMockTest).filter(/** @returns {m is MockTest} */ (m) => !!m);
    },

    /**
     * Registrations of opted-in, non-stopped users with their olympiad and settings.
     * @returns {Promise<ReminderCandidate[]>}
     */
    async reminderCandidates() {
      const r = await db.query(
        `SELECT u.user_id, p.data AS registration, rec.data AS olympiad, s.data AS settings
           FROM bot_users u
           JOIN progress p
             ON p.user_id = 'max:' || u.user_id AND p.key LIKE 'registration:%'
           JOIN records rec
             ON rec.id = substr(p.key, 14) AND rec.kind = 'olympiads' AND rec.deleted = 0
           LEFT JOIN progress s
             ON s.user_id = p.user_id AND s.key = 'settings'
          WHERE u.reminders_enabled AND u.stopped_at IS NULL
          ORDER BY u.user_id, p.key`,
      );
      return r.rows.map((row) => ({
        userId: String(row.user_id),
        registration: parseJson(row.registration),
        olympiad: parseJson(row.olympiad),
        settings: parseJson(row.settings),
      }));
    },

    /**
     * Reserves a reminder before sending it; false when it was already sent/claimed.
     * @param {string} userId
     * @param {string} olympiadId
     * @param {"d3" | "d1"} kind
     */
    async claimReminder(userId, olympiadId, kind) {
      const r = await db.query(
        `INSERT INTO bot_reminders (user_id, olympiad_id, kind, sent_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [userId, olympiadId, kind, now()],
      );
      return r.rows.length === 1;
    },

    /**
     * Frees a claim after a failed send so the next run can retry.
     * @param {string} userId
     * @param {string} olympiadId
     * @param {"d3" | "d1"} kind
     */
    async releaseReminder(userId, olympiadId, kind) {
      await db.query(
        "DELETE FROM bot_reminders WHERE user_id = $1 AND olympiad_id = $2 AND kind = $3",
        [userId, olympiadId, kind],
      );
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */
