// @ts-check
/**
 * Turns the app's `progress` rows of one user into a short summary for the chat.
 * Pure functions; the data model is described in lib/domain/types.ts.
 */

import { countsAsSolved, MEDALS } from "../lib/domain/achievements.mjs";
import { isUpcoming } from "./olympiads.mjs";
import { isIsoDate } from "./time.mjs";

/** Medal thresholds per subject, shared with the app (lib/domain/achievements.mjs). */
export const MEDAL_THRESHOLDS = MEDALS.map((m) => m.threshold);
export const MEDAL_NAMES = MEDALS.map((m) => m.name);
const SUBJECTS = /** @type {const} */ (["math", "info"]);

/**
 * @typedef {import("./olympiads.mjs").Olympiad} Olympiad
 * @typedef {{ key: string, data: unknown }} ProgressRow
 * @typedef {{ region?: string, grade?: number, subject?: string }} UserSettings
 *
 * @typedef {object} ProgressSummary
 * @property {boolean} hasData the user has any progress in the app
 * @property {UserSettings} settings
 * @property {number} stars
 * @property {{ math: number, info: number, total: number }} solved
 * @property {{ earned: number, total: number, next?: { name: string, subject: string, remaining: number } }} medals
 * @property {{ title: string, score: number, max: number, finishedAt?: number } | undefined} lastMock
 * @property {string[]} registeredIds ids of olympiads marked in «Мои олимпиады»
 * @property {Olympiad[]} upcoming registered olympiads with a date, soonest first
 * @property {Olympiad[]} expected registered olympiads without an announced date
 */

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function object(value) {
  return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : {};
}

/**
 * Settings (`settings` key) with invalid values dropped.
 * @param {unknown} value
 * @returns {UserSettings}
 */
export function parseSettings(value) {
  const s = object(value);
  /** @type {UserSettings} */
  const settings = {};
  if (typeof s.region === "string" && s.region.trim()) settings.region = s.region.trim();
  const grade = Number(s.grade);
  if ([4, 5, 6].includes(grade)) settings.grade = grade;
  if (s.subject === "math" || s.subject === "info") settings.subject = s.subject;
  return settings;
}

/**
 * Ids of olympiads the child marked as «участвую».
 * @param {ProgressRow[]} rows
 */
export function registeredOlympiadIds(rows) {
  return rows
    .filter((r) => r.key.startsWith("registration:") && object(r.data).registered === true)
    .map((r) => r.key.slice("registration:".length))
    .filter(Boolean);
}

/**
 * @param {Record<string, number>} solved
 */
function medalProgress(solved) {
  let earned = 0;
  /** @type {{ name: string, subject: string, remaining: number } | undefined} */
  let next;
  for (const subject of SUBJECTS) {
    const n = solved[subject] || 0;
    earned += MEDAL_THRESHOLDS.filter((t) => n >= t).length;
    const index = MEDAL_THRESHOLDS.findIndex((t) => n < t);
    if (index === -1) continue;
    const remaining = MEDAL_THRESHOLDS[index] - n;
    // Suggest the medal that is closest to being earned.
    if (!next || remaining < next.remaining)
      next = { name: MEDAL_NAMES[index], subject, remaining };
  }
  return { earned, total: MEDAL_THRESHOLDS.length * SUBJECTS.length, next };
}

/**
 * @param {ProgressRow[]} rows all progress rows of one user
 * @param {Map<string, Olympiad>} olympiadsById registered olympiads (published)
 * @param {string} today `YYYY-MM-DD` in Moscow
 * @returns {ProgressSummary}
 */
export function summarizeProgress(rows, olympiadsById, today) {
  let stars = 0;
  const solved = { math: 0, info: 0 };
  /** @type {ProgressSummary["lastMock"]} */
  let lastMock;
  let lastMockAt = -1;
  /** @type {UserSettings} */
  let settings = {};

  for (const row of rows) {
    const data = object(row.data);
    if (
      row.key.startsWith("theory-star:") ||
      row.key.startsWith("practice-star:") ||
      row.key.startsWith("star:")
    ) {
      stars += 1;
    } else if (row.key.startsWith("task:")) {
      if (countsAsSolved(data) && (data.subject === "math" || data.subject === "info"))
        solved[/** @type {"math" | "info"} */ (data.subject)] += 1;
    } else if (row.key.startsWith("attempt:")) {
      const at = Number(data.finishedAt || data.ends || data.started || 0);
      if (
        data.finished === true &&
        Number.isFinite(Number(data.score)) &&
        Number(data.max) > 0 &&
        at > lastMockAt
      ) {
        lastMockAt = at;
        lastMock = {
          title: String(data.title || "Пробный тур"),
          score: Number(data.score),
          max: Number(data.max),
          finishedAt: Number(data.finishedAt) || undefined,
        };
      }
    } else if (row.key === "settings") {
      settings = parseSettings(data);
    }
  }

  const registeredIds = registeredOlympiadIds(rows);
  const registered = registeredIds
    .map((id) => olympiadsById.get(id))
    .filter(/** @returns {o is Olympiad} */ (o) => Boolean(o));
  const upcoming = registered
    .filter((o) => isUpcoming(o, today))
    .sort((a, b) => a.date.localeCompare(b.date));
  const expected = registered.filter((o) => !isIsoDate(o.date));

  return {
    hasData: rows.length > 0,
    settings,
    stars,
    solved: { ...solved, total: solved.math + solved.info },
    medals: medalProgress(solved),
    lastMock,
    registeredIds,
    upcoming,
    expected,
  };
}
