// @ts-check
/**
 * Olympiad calendar logic for the chat (pure functions, no I/O).
 *
 * Mirrors the scope rules of the app (lib/domain/types.ts, `Olympiad`):
 * - `region === ""` – open to the whole country;
 * - `region !== ""` – only for that region;
 * - editions of one olympiad in different regions share `series`; without a chosen
 *   region they are shown as one collapsed item.
 */

import { isIsoDate } from "./time.mjs";

/**
 * Olympiad record as stored in `records.data` (only the fields the bot uses).
 * @typedef {object} Olympiad
 * @property {string} id
 * @property {string} title
 * @property {string} subject
 * @property {string[]} [subjects]
 * @property {number[]} grades
 * @property {string} [format]
 * @property {string} region
 * @property {string} [series]
 * @property {string} [stage]
 * @property {string} [registrationType]
 * @property {string} [url]
 * @property {string} [deadline]
 * @property {string} date `YYYY-MM-DD` or `expected`
 * @property {string} [dateEnd]
 * @property {boolean} [featured]
 * @property {boolean} [demo]
 * @property {boolean} [unpublished]
 */

/**
 * Mock test record (`records.kind = 'mock-tests'`).
 * @typedef {object} MockTest
 * @property {string} id
 * @property {string} title
 * @property {number} grade
 * @property {string} subject
 * @property {string} olympiad
 * @property {number} [minutes]
 * @property {boolean} [unpublished]
 */

/**
 * @typedef {object} CalendarItem
 * @property {Olympiad} olympiad representative record (the earliest edition of a series)
 * @property {number} editions how many regional editions were collapsed into this item
 */

/**
 * Validates the minimal shape of an olympiad from the database. Unknown or broken
 * records are skipped instead of breaking the whole calendar.
 * @param {unknown} raw
 * @returns {Olympiad | null}
 */
export function normalizeOlympiad(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.id !== "string" || !r.id || typeof r.title !== "string" || !r.title.trim())
    return null;
  if (r.unpublished === true) return null;
  const grades = Array.isArray(r.grades) ? r.grades.map(Number).filter(Number.isFinite) : [];
  return {
    .../** @type {Partial<Olympiad>} */ (r),
    id: r.id,
    title: r.title.trim(),
    subject: typeof r.subject === "string" ? r.subject : "",
    grades,
    region: typeof r.region === "string" ? r.region.trim() : "",
    series: typeof r.series === "string" && r.series.trim() ? r.series.trim() : undefined,
    date: typeof r.date === "string" ? r.date.trim() : "expected",
    dateEnd: isIsoDate(r.dateEnd) ? r.dateEnd : undefined,
  };
}

/**
 * @param {unknown} raw
 * @returns {MockTest | null}
 */
export function normalizeMockTest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.id !== "string" || !r.id || typeof r.title !== "string") return null;
  if (r.unpublished === true) return null;
  return {
    id: r.id,
    title: r.title,
    grade: Number(r.grade),
    subject: typeof r.subject === "string" ? r.subject : "",
    olympiad: typeof r.olympiad === "string" ? r.olympiad : "",
    minutes: Number(r.minutes) || undefined,
  };
}

/**
 * The olympiad has a concrete date and has not finished yet (multi-day events stay
 * visible until their last day).
 * @param {Olympiad} o
 * @param {string} today `YYYY-MM-DD` in Moscow
 */
export function isUpcoming(o, today) {
  if (!isIsoDate(o.date)) return false;
  return (o.dateEnd && o.dateEnd >= o.date ? o.dateEnd : o.date) >= today;
}

/**
 * @param {Olympiad} o
 * @param {number | undefined} grade
 */
export function matchesGrade(o, grade) {
  return !grade || o.grades.includes(grade);
}

/**
 * @param {Olympiad} o
 * @param {string | undefined} region
 */
export function matchesRegion(o, region) {
  return !o.region || (Boolean(region) && o.region === region);
}

/**
 * @param {Olympiad} a
 * @param {Olympiad} b
 */
function byDate(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    Number(Boolean(b.featured)) - Number(Boolean(a.featured)) ||
    a.title.localeCompare(b.title, "ru")
  );
}

/**
 * Upcoming olympiads relevant to a child.
 *
 * - With a region: all-Russia events plus the events of that region.
 * - Without a region: all-Russia events plus regional series collapsed into one item
 *   (e.g. the school stage of ВсОШ); one-off regional events are left out.
 * - With a grade: only olympiads for that grade.
 * - Past olympiads and those with a date «ожидается» are excluded.
 *
 * @param {Olympiad[]} olympiads
 * @param {{ today: string, region?: string, grade?: number, limit?: number }} options
 * @returns {{ items: CalendarItem[], total: number }}
 */
export function selectUpcoming(olympiads, { today, region, grade, limit = 5 }) {
  const candidates = olympiads
    .filter((o) => isUpcoming(o, today) && matchesGrade(o, grade))
    .filter((o) => matchesRegion(o, region) || (!region && Boolean(o.series)))
    .sort(byDate);

  /** @type {CalendarItem[]} */
  const items = [];
  /** @type {Map<string, { item: CalendarItem, regions: Set<string> }>} */
  const bySeries = new Map();
  for (const olympiad of candidates) {
    if (!olympiad.series) {
      items.push({ olympiad, editions: 1 });
      continue;
    }
    const group = bySeries.get(olympiad.series);
    if (group) {
      // Sorted by date: the first edition met is the earliest one and represents the series.
      group.regions.add(olympiad.region);
      group.item.editions = group.regions.size;
      continue;
    }
    const item = { olympiad, editions: 1 };
    bySeries.set(olympiad.series, { item, regions: new Set([olympiad.region]) });
    items.push(item);
  }
  return { items: items.slice(0, limit), total: items.length };
}

/**
 * @param {string} value
 */
function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

/**
 * Mock test to suggest before an olympiad: one prepared for this olympiad (its
 * `olympiad` field names it), otherwise a general mock of the same subject for the
 * child's grade. Null when nothing fits or the grade is ambiguous.
 * @param {Olympiad} olympiad
 * @param {MockTest[]} mocks
 * @param {number | undefined} grade the child's grade from app settings
 * @returns {MockTest | null}
 */
export function pickMockTest(olympiad, mocks, grade) {
  const subjects = olympiad.subjects?.length ? olympiad.subjects : [olympiad.subject];
  const suitable = mocks
    .filter(
      (m) =>
        subjects.includes(m.subject) &&
        (!olympiad.grades.length || olympiad.grades.includes(m.grade)) &&
        (!grade || m.grade === grade),
    )
    .sort((a, b) => a.grade - b.grade || a.id.localeCompare(b.id));
  const title = normalizeName(olympiad.title);
  const named = suitable.filter((m) => {
    const name = normalizeName(m.olympiad);
    return name.length > 2 && (title.includes(name) || name.includes(title));
  });
  const choice = named.length ? named : grade ? suitable : [];
  if (!choice.length) return null;
  if (!grade && new Set(choice.map((m) => m.grade)).size > 1) return null;
  return choice[0];
}
