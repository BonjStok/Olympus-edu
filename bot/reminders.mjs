// @ts-check
/**
 * Olympiad reminders («через 3 дня» and «завтра»).
 *
 * Off by default (BOT_REMINDERS=off): MAX rules (Требования, п. 1.5) forbid sending
 * «Сервисные сообщения» through the API unless the contract with MAX allows it.
 * When enabled, reminders go only to users who opted in with a button or /reminders,
 * who have not stopped the bot, and only about olympiads they marked in «Мои олимпиады».
 * Each (user, olympiad, kind) is sent at most once (row in bot_reminders).
 */

import { normalizeOlympiad, pickMockTest } from "./olympiads.mjs";
import { parseSettings } from "./progress.mjs";
import { daysBetween, isIsoDate, moscowParts } from "./time.mjs";
import { errorFields } from "./log.mjs";

/** @typedef {import("./olympiads.mjs").Olympiad} Olympiad */
/** @typedef {import("./olympiads.mjs").MockTest} MockTest */
/** @typedef {import("./store.mjs").ReminderCandidate} ReminderCandidate */
/** @typedef {"d3" | "d1"} ReminderKind */

/** Days before the olympiad for each reminder kind. */
export const REMINDER_DAYS = /** @type {const} */ ({ d3: 3, d1: 1 });

/**
 * @typedef {{ startHour: number, endHour: number }} ReminderWindow Moscow hours, [start, end)
 */

/**
 * The reminder window is 10:00–20:00 Moscow time (end exclusive).
 * @param {number} now
 * @param {ReminderWindow} window
 */
export function inReminderWindow(now, window) {
  const { hour } = moscowParts(now);
  return hour >= window.startHour && hour < window.endHour;
}

/**
 * Which reminder is due today for an olympiad on `date`, if any.
 * @param {string} date olympiad date `YYYY-MM-DD`
 * @param {number} now
 * @param {ReminderWindow} window
 * @returns {ReminderKind | null}
 */
export function dueReminderKind(date, now, window) {
  if (!isIsoDate(date) || !inReminderWindow(now, window)) return null;
  const days = daysBetween(moscowParts(now).date, date);
  if (days === REMINDER_DAYS.d3) return "d3";
  if (days === REMINDER_DAYS.d1) return "d1";
  return null;
}

/**
 * @typedef {object} PlannedReminder
 * @property {string} userId
 * @property {Olympiad} olympiad
 * @property {ReminderKind} kind
 * @property {number | undefined} grade
 */

/**
 * Reminders due now for the given candidates (pure; already-sent ones are filtered
 * by the caller's `sent` set and, authoritatively, by the database claim).
 * @param {ReminderCandidate[]} candidates
 * @param {number} now
 * @param {ReminderWindow} window
 * @param {Set<string>} [sent] keys `${userId}:${olympiadId}:${kind}`
 * @returns {PlannedReminder[]}
 */
export function planReminders(candidates, now, window, sent = new Set()) {
  if (!inReminderWindow(now, window)) return [];
  /** @type {PlannedReminder[]} */
  const plan = [];
  const seen = new Set();
  for (const c of candidates) {
    const registration = /** @type {Record<string, unknown> | null} */ (c.registration);
    if (!registration || registration.registered !== true) continue;
    const olympiad = normalizeOlympiad(c.olympiad);
    if (!olympiad) continue;
    const kind = dueReminderKind(olympiad.date, now, window);
    if (!kind) continue;
    const key = `${c.userId}:${olympiad.id}:${kind}`;
    if (seen.has(key) || sent.has(key)) continue;
    seen.add(key);
    plan.push({ userId: c.userId, olympiad, kind, grade: parseSettings(c.settings).grade });
  }
  return plan;
}

/**
 * @typedef {object} TickDeps
 * @property {import("./store.mjs").Store} store
 * @property {(userId: string, body: import("./api.mjs").NewMessageBody) => Promise<unknown>} send
 * @property {(p: { kind: ReminderKind, olympiad: Olympiad, mock: MockTest | null }) => import("./api.mjs").NewMessageBody} render
 * @property {import("./log.mjs").Logger} logger
 * @property {() => number} now
 * @property {ReminderWindow} window
 */

/**
 * One scheduler run: claim → send → keep (sent), release (transient error) or
 * mark the user stopped (403).
 * @param {TickDeps} deps
 */
export async function runReminderTick({ store, send, render, logger, now, window }) {
  const stats = { planned: 0, sent: 0, skipped: 0, failed: 0, stopped: 0 };
  const t = now();
  if (!inReminderWindow(t, window)) return { ...stats, outsideWindow: true };
  const candidates = await store.reminderCandidates();
  const plan = planReminders(candidates, t, window);
  stats.planned = plan.length;
  if (!plan.length) return stats;
  const mocks = await store.loadMockTests();
  const stoppedUsers = new Set();

  for (const item of plan) {
    if (stoppedUsers.has(item.userId)) {
      stats.skipped += 1;
      continue;
    }
    const claimed = await store.claimReminder(item.userId, item.olympiad.id, item.kind);
    if (!claimed) {
      stats.skipped += 1;
      continue;
    }
    const mock = pickMockTest(item.olympiad, mocks, item.grade);
    try {
      await send(item.userId, render({ kind: item.kind, olympiad: item.olympiad, mock }));
      stats.sent += 1;
      logger.info("reminder_sent", {
        userId: item.userId,
        olympiadId: item.olympiad.id,
        kind: item.kind,
      });
    } catch (error) {
      const e = /** @type {{ status?: number }} */ (error);
      if (e?.status === 403) {
        // The user blocked the bot or the chat is closed: never write again until they return.
        stoppedUsers.add(item.userId);
        stats.stopped += 1;
        await store.markStopped(item.userId);
        logger.warn("reminder_forbidden", { userId: item.userId, ...errorFields(error) });
      } else {
        stats.failed += 1;
        await store.releaseReminder(item.userId, item.olympiad.id, item.kind);
        logger.error("reminder_failed", {
          userId: item.userId,
          olympiadId: item.olympiad.id,
          kind: item.kind,
          ...errorFields(error),
        });
        if (e?.status === 401) break;
      }
    }
  }
  return stats;
}

/**
 * Periodic runner; never overlaps runs.
 * @param {{ tick: () => Promise<unknown>, intervalMs: number, logger: import("./log.mjs").Logger }} p
 */
export function createScheduler({ tick, intervalMs, logger }) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let first = null;
  /** @type {Promise<unknown> | null} */
  let running = null;

  async function run() {
    if (running) return running;
    running = tick()
      .then((stats) => {
        logger.debug("reminder_tick", /** @type {Record<string, unknown>} */ (stats));
        return stats;
      })
      .catch((error) => logger.error("reminder_tick_failed", errorFields(error)))
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    run,
    start() {
      if (timer) return;
      timer = setInterval(run, intervalMs);
      timer.unref?.();
      first = setTimeout(run, Math.min(5_000, intervalMs));
      first.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = null;
      first = null;
      await running;
    },
  };
}
