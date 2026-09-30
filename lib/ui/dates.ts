/**
 * Date helpers for the calendar and history screens. All calendar dates are
 * plain `YYYY-MM-DD` strings in Moscow time – the organisers publish them so.
 */
import { serverNow } from "@/lib/client/clock";

const EXPECTED = new Set(["", "expected", "pending", "ожидается"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "нояб",
  "дек",
];

const MONTHS_NOMINATIVE = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

export const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

/** The organiser has not announced the date yet (`expected`, `ожидается`, empty). */
export function isExpectedDate(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return EXPECTED.has(String(value).trim().toLowerCase());
}

/** A real `YYYY-MM-DD` date. */
export function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && ISO_DAY.test(value);
}

/** Today in Moscow as `YYYY-MM-DD` (by the server clock: the device clock may be wrong). */
export function todayIso(now: Date = new Date(serverNow()), timeZone = "Europe/Moscow"): string {
  try {
    return now.toLocaleDateString("en-CA", { timeZone });
  } catch {
    return toIsoDay(now);
  }
}

export function toIsoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m: m - 1, d };
}

/** «20 октября» («20 окт» with `short`); the year is added when it differs from `currentYear`. */
export function formatDay(iso: string, currentYear?: number, short = false): string {
  if (!isIsoDay(iso)) return "Ожидается";
  const { y, m, d } = parts(iso);
  const base = `${d} ${(short ? MONTHS_SHORT : MONTHS_GENITIVE)[m]}`;
  return currentYear !== undefined && y !== currentYear ? `${base} ${y}` : base;
}

/** «20–25 октября», «30 сентября – 2 октября», «20 окт – 10 нояб» (`short`). */
export function formatRange(
  start: string,
  end?: string,
  currentYear?: number,
  short = false,
): string {
  if (!isIsoDay(start)) return "Ожидается";
  if (!end || !isIsoDay(end) || end <= start) return formatDay(start, currentYear, short);
  const months = short ? MONTHS_SHORT : MONTHS_GENITIVE;
  const a = parts(start);
  const b = parts(end);
  const yearSuffix = currentYear !== undefined && b.y !== currentYear ? ` ${b.y}` : "";
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${months[b.m]}${yearSuffix}`;
  const startLabel =
    a.y !== b.y ? formatDay(start, currentYear ?? b.y + 1, short) : `${a.d} ${months[a.m]}`;
  return `${startLabel} – ${b.d} ${months[b.m]}${yearSuffix}`;
}

/** «Октябрь 2026». */
export function formatMonth(year: number, month: number): string {
  return `${MONTHS_NOMINATIVE[month]} ${year}`;
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = parts(fromIso);
  const b = parts(toIso);
  return Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86_400_000);
}

/** «сегодня», «завтра», «через 5 дней», «вчера», «3 дня назад». */
export function relativeDays(days: number): string {
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  if (days === -1) return "вчера";
  const n = Math.abs(days);
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "день"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "дня"
        : "дней";
  return days > 0 ? `через ${n} ${word}` : `${n} ${word} назад`;
}

/** «29 сентября, 16:05» for timestamps (attempt history). */
export function formatDateTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const day = `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]}`;
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${day}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `mm:ss` for the mock timer – also for 60–99 minutes («75:00», like olympiad rules say
 * «75 минут»), `h:mm:ss` only beyond that.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const s = total % 60;
  if (minutes < 100) return `${pad(minutes)}:${pad(s)}`;
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(s)}`;
}

export interface MonthCell {
  /** `YYYY-MM-DD` of the day, or null for leading blanks. */
  iso: string | null;
  day: number;
}

/** Days of a month laid out Monday-first, with leading blanks. */
export function monthGrid(year: number, month: number): MonthCell[] {
  const first = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: MonthCell[] = Array.from({ length: first }, () => ({ iso: null, day: 0 }));
  for (let d = 1; d <= days; d++)
    cells.push({ iso: `${year}-${pad(month + 1)}-${pad(d)}`, day: d });
  return cells;
}

export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}
