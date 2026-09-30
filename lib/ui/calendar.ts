/**
 * Olympiad calendar logic (schema v2, see `lib/domain/types.ts`):
 *
 * - `region === ""` means the olympiad is open to the whole country; any other value
 *   means it belongs to that region only – even when it is held online;
 * - with a region chosen the list shows all-Russia events plus that region;
 * - with no region chosen, regional editions of one olympiad (same `series`, or the same
 *   title and subject repeated in at least three regions) collapse into a single card;
 * - the list is split into sections: open registration first, then «скоро» and
 *   «даты уточняются», then closed registration and past events.
 */
import type {
  Grade,
  Olympiad,
  OlympiadDetailField,
  OlympiadSummary,
  ProgressMap,
  Subject,
} from "@/lib/domain/types";
import { daysBetween, isIsoDay } from "./dates";
import { sameRegion } from "./regions";

export type FormatFilter = "all" | "online" | "offline";

export interface CalendarFilters {
  grade: Grade | "all";
  subject: Subject | "all";
  /** Region name from `lib/regions.ts`; `""` – not chosen. */
  region: string;
  format: FormatFilter;
}

export const DEFAULT_FILTERS: CalendarFilters = {
  grade: "all",
  subject: "all",
  region: "",
  format: "all",
};

export type RegistrationState = "open" | "not-started" | "closed";

export interface EventTiming {
  /** The olympiad (its last day) is over. */
  past: boolean;
  registration: RegistrationState;
  /** The olympiad day is known (not «ожидается»). */
  dateKnown: boolean;
  /** Days left until the registration deadline (0 – today). */
  daysToDeadline?: number;
  /** Days until the olympiad starts. */
  daysToStart?: number;
}

export interface EventEntry {
  kind: "event";
  key: string;
  event: OlympiadSummary;
  timing: EventTiming;
}

export interface SeriesEntry {
  kind: "series";
  key: string;
  /** Title without the stage suffix: «ВсОШ – математика». */
  title: string;
  /** «школьный этап», when known. */
  stage?: string;
  subject: Subject;
  grades: Grade[];
  /** All regional editions (including past ones). */
  events: OlympiadSummary[];
  regionCount: number;
  /** Range of dates of the editions that are not over yet (or of all, if all are over). */
  dateFrom?: string;
  dateTo?: string;
  /** Earliest registration deadline that has not passed yet. */
  deadlineFrom?: string;
  timing: EventTiming;
  demo: boolean;
}

export type CalendarEntry = EventEntry | SeriesEntry;

export type SectionId = "open" | "soon" | "tbd" | "closed" | "past";

export const SECTION_TITLE: Record<SectionId, string> = {
  open: "Можно зарегистрироваться",
  soon: "Регистрация скоро откроется",
  tbd: "Даты уточняются",
  closed: "Регистрация закрыта",
  past: "Прошедшие",
};

/** Sections that start collapsed: they are not actionable for the child. */
export const COLLAPSED_SECTIONS: readonly SectionId[] = ["closed", "past"];

export interface CalendarSection {
  id: SectionId;
  title: string;
  entries: CalendarEntry[];
}

export interface CalendarView {
  /** Non-empty sections in display order. */
  sections: CalendarSection[];
  /** Every entry matching the filters (the month grid shows the same set). */
  entries: CalendarEntry[];
}

/** Fallback grouping needs at least this many regional copies without `series`. */
export const SERIES_FALLBACK_MIN = 3;

export function isAllRussia(e: Pick<OlympiadSummary, "region">): boolean {
  return !e.region || !e.region.trim();
}

export function isSchoolRegistration(e: Pick<OlympiadSummary, "registrationType">): boolean {
  return e.registrationType === "school";
}

export function eventTiming(e: OlympiadSummary, today: string): EventTiming {
  const lastDay = isIsoDay(e.dateEnd) ? e.dateEnd : isIsoDay(e.date) ? e.date : undefined;
  const past = lastDay !== undefined && lastDay < today;
  let registration: RegistrationState = "open";
  if (isIsoDay(e.registrationStart) && today < e.registrationStart) registration = "not-started";
  // The school registers participants itself: there is no deadline for the child.
  if (!isSchoolRegistration(e) && isIsoDay(e.deadline) && e.deadline < today)
    registration = "closed";
  if (past) registration = "closed";
  return {
    past,
    registration,
    dateKnown: isIsoDay(e.date),
    daysToDeadline: isIsoDay(e.deadline) ? daysBetween(today, e.deadline) : undefined,
    daysToStart: isIsoDay(e.date) ? daysBetween(today, e.date) : undefined,
  };
}

export function sectionOf(t: EventTiming): SectionId {
  if (t.past) return "past";
  if (t.registration === "closed") return "closed";
  if (t.registration === "not-started") return "soon";
  if (!t.dateKnown) return "tbd";
  return "open";
}

export function matchesFilters(e: OlympiadSummary, f: CalendarFilters, withRegion = true): boolean {
  if (f.grade !== "all" && !e.grades?.includes(f.grade)) return false;
  if (f.subject !== "all" && e.subject !== f.subject && !e.subjects?.includes(f.subject))
    return false;
  if (f.format !== "all" && e.format !== f.format) return false;
  if (withRegion && f.region && !isAllRussia(e) && !sameRegion(e.region, f.region)) return false;
  return true;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'“”„]/g, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

// Separator: hyphen, en dash or em dash (old data and text pasted from Word use \u2014).
const STAGE_RE = /^(.*\S)\s+[\u2013\u2014-]\s+([^\u2013\u2014]*этап[^\u2013\u2014]*)$/i;

/** Splits «ВсОШ – математика – школьный этап» into title and stage. */
export function splitStage(e: Pick<OlympiadSummary, "title" | "stage">): {
  title: string;
  stage?: string;
} {
  const m = STAGE_RE.exec(e.title.trim());
  if (e.stage) {
    const stage = e.stage.trim();
    const title = m && normalizeTitle(m[2]) === normalizeTitle(stage) ? m[1] : e.title.trim();
    return { title, stage: stage.charAt(0).toLowerCase() + stage.slice(1) };
  }
  if (m) return { title: m[1], stage: m[2].trim() };
  return { title: e.title.trim() };
}

function seriesKey(e: OlympiadSummary): { key: string; explicit: boolean } {
  if (e.series) return { key: `s:${e.series}`, explicit: true };
  return { key: `t:${normalizeTitle(e.title)}|${e.subject}`, explicit: false };
}

const FAR = "9999-99-99";
/** One collator for all sorts: `localeCompare(…, "ru")` builds a new one on every call. */
const byTitle = new Intl.Collator("ru");

function entryDate(entry: CalendarEntry): string {
  if (entry.kind === "series") return entry.dateFrom ?? FAR;
  return isIsoDay(entry.event.date) ? entry.event.date : FAR;
}

function entryDeadline(entry: CalendarEntry): string {
  if (entry.kind === "series") return entry.deadlineFrom ?? entryDate(entry);
  return isIsoDay(entry.event.deadline) ? entry.event.deadline : entryDate(entry);
}

function entryRegistrationStart(entry: CalendarEntry): string {
  if (entry.kind === "series") {
    const d = entry.events
      .map((e) => e.registrationStart)
      .filter(isIsoDay)
      .sort();
    return d[0] ?? FAR;
  }
  return isIsoDay(entry.event.registrationStart) ? entry.event.registrationStart : FAR;
}

function entryFeatured(entry: CalendarEntry): boolean {
  return entry.kind === "event" && !!entry.event.featured;
}

function entryTitle(entry: CalendarEntry): string {
  return entry.kind === "series" ? entry.title : entry.event.title;
}

/** Order inside a section: the most urgent first. */
export function compareInSection(section: SectionId, a: CalendarEntry, b: CalendarEntry): number {
  if (section === "open" && entryFeatured(a) !== entryFeatured(b)) return entryFeatured(a) ? -1 : 1;
  let ka: string;
  let kb: string;
  if (section === "open") {
    ka = entryDeadline(a);
    kb = entryDeadline(b);
  } else if (section === "soon") {
    ka = entryRegistrationStart(a);
    kb = entryRegistrationStart(b);
  } else {
    ka = entryDate(a);
    kb = entryDate(b);
  }
  if (ka !== kb) return section === "past" ? kb.localeCompare(ka) : ka.localeCompare(kb);
  const da = entryDate(a);
  const db = entryDate(b);
  if (da !== db) return da.localeCompare(db);
  return byTitle.compare(entryTitle(a), entryTitle(b));
}

function buildSeries(key: string, events: OlympiadSummary[], today: string): SeriesEntry {
  const timings = events.map((e) => eventTiming(e, today));
  const live = events.filter((_, i) => !timings[i].past);
  const pool = live.length ? live : events;
  const dates = pool
    .map((e) => e.date)
    .filter(isIsoDay)
    .sort();
  const liveTimings = timings.filter((t) => !t.past);
  const registration: RegistrationState = liveTimings.some((t) => t.registration === "open")
    ? "open"
    : liveTimings.some((t) => t.registration === "not-started")
      ? "not-started"
      : "closed";
  const { title, stage } = splitStage(events[0]);
  const grades = Array.from(new Set(events.flatMap((e) => e.grades ?? []))).sort() as Grade[];
  const deadlines = live
    .map((e) => e.deadline)
    .filter((d): d is string => isIsoDay(d) && d >= today)
    .sort();
  return {
    kind: "series",
    key,
    title,
    stage,
    subject: events[0].subject,
    grades,
    events,
    regionCount: new Set(events.map((e) => e.region)).size,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    deadlineFrom: deadlines[0],
    timing: {
      past: live.length === 0,
      registration,
      dateKnown: dates.length > 0,
    },
    demo: events.every((e) => !!e.demo),
  };
}

function eventEntry(event: OlympiadSummary, today: string): EventEntry {
  return { kind: "event", key: event.id, event, timing: eventTiming(event, today) };
}

const SECTION_ORDER: readonly SectionId[] = ["open", "soon", "tbd", "closed", "past"];

/** Builds what the calendar shows for the given filters. */
export function buildCalendar(
  olympiads: OlympiadSummary[],
  filters: CalendarFilters,
  today: string,
): CalendarView {
  const matching = olympiads.filter((e) => matchesFilters(e, filters));
  let entries: CalendarEntry[];

  if (filters.region) {
    entries = matching.map((e) => eventEntry(e, today));
  } else {
    const groups = new Map<string, { explicit: boolean; events: OlympiadSummary[] }>();
    entries = [];
    for (const e of matching) {
      if (isAllRussia(e)) {
        entries.push(eventEntry(e, today));
        continue;
      }
      const { key, explicit } = seriesKey(e);
      const g = groups.get(key) ?? { explicit, events: [] };
      g.events.push(e);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const collapse = g.explicit ? g.events.length >= 2 : g.events.length >= SERIES_FALLBACK_MIN;
      if (collapse) entries.push(buildSeries(key, g.events, today));
      else for (const e of g.events) entries.push(eventEntry(e, today));
    }
  }

  const bySection = new Map<SectionId, CalendarEntry[]>();
  for (const entry of entries) {
    const id = sectionOf(entry.timing);
    const list = bySection.get(id) ?? [];
    list.push(entry);
    bySection.set(id, list);
  }
  const sections = SECTION_ORDER.filter((id) => bySection.get(id)?.length).map((id) => ({
    id,
    title: SECTION_TITLE[id],
    entries: (bySection.get(id) as CalendarEntry[]).sort((a, b) => compareInSection(id, a, b)),
  }));
  return { sections, entries: sections.flatMap((s) => s.entries) };
}

export interface DayMarks {
  /** Olympiads held on that day. */
  events: EventEntry[];
  /** Olympiads whose registration ends that day. */
  deadlines: EventEntry[];
}

/** Olympiad days and registration deadlines by `YYYY-MM-DD` – for the month grid. */
export function dayIndex(entries: CalendarEntry[]): Map<string, DayMarks> {
  const map = new Map<string, DayMarks>();
  const at = (iso: string) => {
    const m = map.get(iso) ?? { events: [], deadlines: [] };
    map.set(iso, m);
    return m;
  };
  for (const entry of entries) {
    if (entry.kind !== "event") continue;
    if (isIsoDay(entry.event.date)) at(entry.event.date).events.push(entry);
    if (isIsoDay(entry.event.deadline) && entry.event.deadline !== entry.event.date)
      at(entry.event.deadline).deadlines.push(entry);
  }
  return map;
}

/** Month to open the grid on: this month, unless the next dated event is later. */
export function initialMonth(
  entries: CalendarEntry[],
  today: string,
): { year: number; month: number } {
  const [y, m] = today.split("-").map(Number);
  const thisMonth = today.slice(0, 7);
  const upcoming = entries
    .filter((e) => !e.timing.past)
    .map(entryDate)
    .filter((d) => d !== FAR && d >= today)
    .sort()[0];
  const hasThisMonth = entries.some((e) => entryDate(e).startsWith(thisMonth));
  if (hasThisMonth || !upcoming) return { year: y, month: m - 1 };
  const [uy, um] = upcoming.split("-").map(Number);
  return { year: uy, month: um - 1 };
}

export function isRegistered(progress: ProgressMap, id: string): boolean {
  return !!progress[`registration:${id}`];
}

/** Olympiads the child confirmed, upcoming first. */
export function registeredEvents(
  olympiads: OlympiadSummary[],
  progress: ProgressMap,
  today: string,
) {
  return olympiads
    .filter((e) => isRegistered(progress, e.id))
    .map((event) => ({ event, timing: eventTiming(event, today) }))
    .sort((a, b) => {
      if (a.timing.past !== b.timing.past) return a.timing.past ? 1 : -1;
      const da = isIsoDay(a.event.date) ? a.event.date : FAR;
      const db = isIsoDay(b.event.date) ? b.event.date : FAR;
      return a.timing.past ? db.localeCompare(da) : da.localeCompare(db);
    });
}

/** The most urgent open olympiad for the child's filters (for «Главная»). */
export function nextOpenEntry(
  olympiads: OlympiadSummary[],
  filters: CalendarFilters,
  today: string,
): CalendarEntry | undefined {
  return buildCalendar(olympiads, filters, today).sections.find((s) => s.id === "open")?.entries[0];
}

/** Human description of what the list shows, e.g. «5 класс · математика · Москва и вся Россия». */
export function describeFilters(f: CalendarFilters): string {
  const parts: string[] = [];
  parts.push(f.grade !== "all" ? `${f.grade} класс` : "все классы");
  if (f.subject !== "all") parts.push(f.subject === "math" ? "математика" : "информатика");
  parts.push(f.region ? `${f.region} и вся Россия` : "все регионы");
  if (f.format !== "all") parts.push(f.format === "online" ? "онлайн" : "очно");
  return parts.join(" · ");
}

/** Decodes one punycode label (RFC 3492), e.g. `xn--h1aamv` → `тиим`. */
export function decodePunycodeLabel(label: string): string {
  if (!label.toLowerCase().startsWith("xn--")) return label;
  const input = label.slice(4);
  const base = 36;
  const out: number[] = [];
  let i = 0;
  let n = 128;
  let bias = 72;
  const delimiter = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(0, delimiter); j++) out.push(input.charCodeAt(j));
  const digit = (c: number) =>
    c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
  const adapt = (delta: number, numPoints: number, first: boolean) => {
    delta = first ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > 455) {
      delta = Math.floor(delta / 35);
      k += base;
    }
    return k + Math.floor((36 * delta) / (delta + 38));
  };
  for (let idx = delimiter > 0 ? delimiter + 1 : 0; idx < input.length;) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= input.length) return label;
      const d = digit(input.charCodeAt(idx++));
      if (d >= base) return label;
      i += d * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (d < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** What the details screen adds to the summary: description, source, check date, picture. */
export type OlympiadDetails = Pick<Olympiad, OlympiadDetailField>;

/**
 * Details that already came with the catalogue entry: older servers and the teacher's catalogue
 * send complete olympiads. `null` for a slim summary – load them with the action `olympiad`.
 */
export function inlineDetails(event: OlympiadSummary): OlympiadDetails | null {
  const { description, source, verifiedAt, image } = event as OlympiadSummary & OlympiadDetails;
  const details = { description, source, verifiedAt, image };
  return Object.values(details).some((value) => value !== undefined) ? details : null;
}

/** Readable domain of a source URL for «источник: olimpiada.ru» (Cyrillic domains decoded). */
export function sourceDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".").map(decodePunycodeLabel).join(".");
  } catch {
    return undefined;
  }
}

/** Several series of one olympiad (e.g. ВсОШ informatics profiles) shown as one card. */
export interface SeriesFamily {
  kind: "family";
  key: string;
  /** «ВсОШ – информатика». */
  title: string;
  stage?: string;
  subject: Subject;
  members: { profile: string; entry: SeriesEntry }[];
}

export type ListItem = CalendarEntry | SeriesFamily;

function familyOf(title: string): { family: string; profile?: string } {
  const i = title.indexOf(":");
  return i < 0
    ? { family: title.trim() }
    : { family: title.slice(0, i).trim(), profile: title.slice(i + 1).trim() };
}

/**
 * Groups series whose titles share a prefix before «:» («ВсОШ – информатика: программирование»,
 * «…: робототехника») into one family card, placed where its first member was.
 */
export function groupFamilies(entries: CalendarEntry[]): ListItem[] {
  const counts = new Map<string, number>();
  for (const e of entries)
    if (e.kind === "series") {
      const key = `${familyOf(e.title).family}|${e.stage ?? ""}`;
      counts.set(key, (counts.get(key) ?? 0) + (familyOf(e.title).profile ? 1 : 0));
    }
  const families = new Map<string, SeriesFamily>();
  const out: ListItem[] = [];
  for (const e of entries) {
    if (e.kind !== "series") {
      out.push(e);
      continue;
    }
    const { family, profile } = familyOf(e.title);
    const key = `${family}|${e.stage ?? ""}`;
    if ((counts.get(key) ?? 0) < 2) {
      out.push(e);
      continue;
    }
    let f = families.get(key);
    if (!f) {
      f = {
        kind: "family",
        key: `family:${key}`,
        title: family,
        stage: e.stage,
        subject: e.subject,
        members: [],
      };
      families.set(key, f);
      out.push(f);
    }
    f.members.push({ profile: profile ?? "без профилей", entry: e });
  }
  return out;
}
