// @ts-check
/**
 * Calendar helpers. Olympiad dates are plain `YYYY-MM-DD` strings in Moscow time,
 * so all "today" / "hour" decisions are made in Europe/Moscow regardless of the
 * server time zone.
 */

export const MOSCOW_TZ = "Europe/Moscow";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const moscowFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MOSCOW_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Wall-clock date and time in Moscow for an instant.
 * @param {number | Date} now
 * @returns {{ date: string, hour: number, minute: number }}
 */
export function moscowParts(now) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of moscowFormatter.formatToParts(new Date(now))) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * Today's date in Moscow as `YYYY-MM-DD`.
 * @param {number | Date} now
 */
export function moscowToday(now) {
  return moscowParts(now).date;
}

/**
 * True for a real calendar date `YYYY-MM-DD` (rejects `expected`, `2026-02-30`, …).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Whole days from `from` to `to` (both `YYYY-MM-DD`). Positive when `to` is later.
 * @param {string} from
 * @param {string} to
 */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
