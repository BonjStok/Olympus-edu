/** Human status lines for olympiad cards and the event screen. */
import type { OlympiadSummary } from "@/lib/domain/types";
import type { CalendarEntry, EventTiming } from "./calendar";
import { isAllRussia, isSchoolRegistration } from "./calendar";
import { formatDay, formatRange, isIsoDay } from "./dates";
import { plural, WORDS } from "./plural";

export type StatusTone = "ok" | "warn" | "muted" | "info";

export const SCHOOL_LINE = "Записывает школа – спроси учителя или классного руководителя";

export interface StatusLine {
  text: string;
  tone: StatusTone;
}

function left(days: number): string {
  if (days === 0) return "последний день";
  if (days === 1) return "остался 1 день";
  return `осталось ${plural(days, WORDS.day)}`;
}

/** «Регистрация до 12 октября · осталось 13 дней», «Записывает школа», … */
export function registrationLine(e: OlympiadSummary, t: EventTiming, year?: number): StatusLine {
  if (t.past) {
    const day = isIsoDay(e.dateEnd) ? e.dateEnd : e.date;
    return { text: `Прошла ${isIsoDay(day) ? formatDay(day, year) : ""}`.trim(), tone: "muted" };
  }
  if (t.registration === "closed") return { text: "Регистрация закрыта", tone: "muted" };
  if (t.registration === "not-started" && isIsoDay(e.registrationStart))
    return { text: `Регистрация откроется ${formatDay(e.registrationStart, year)}`, tone: "info" };
  if (isSchoolRegistration(e)) return { text: SCHOOL_LINE, tone: "info" };
  if (isIsoDay(e.deadline) && t.daysToDeadline !== undefined)
    return {
      text: `Регистрация до ${formatDay(e.deadline, year)} · ${left(t.daysToDeadline)}`,
      tone: t.daysToDeadline <= 3 ? "warn" : "ok",
    };
  if (!t.dateKnown) return { text: "Даты уточняются", tone: "info" };
  return { text: "Срок регистрации уточняется", tone: "info" };
}

/** «20 октября», «20 окт – 10 нояб» (`short`) or «Ожидается». */
export function eventDateLabel(
  e: Pick<OlympiadSummary, "date" | "dateEnd">,
  year?: number,
  short = false,
): string {
  if (!isIsoDay(e.date)) return "Ожидается";
  return formatRange(e.date, e.dateEnd, year, short);
}

export function formatLabel(e: Pick<OlympiadSummary, "format">): string {
  return e.format === "online" ? "Онлайн" : "Очно";
}

/** «Онлайн · вся Россия», «Онлайн · Москва», «Очно · по всей России», «Очно · Москва». */
export function placeLabel(e: Pick<OlympiadSummary, "region" | "format">): string {
  if (isAllRussia(e))
    return e.format === "online" ? "Онлайн · вся Россия" : "Очно · по всей России";
  return `${formatLabel(e)} · ${e.region}`;
}

export function entryTitle(entry: CalendarEntry): string {
  return entry.kind === "series" ? entry.title : entry.event.title;
}

/** «школьный этап · в 86 регионах · даты зависят от региона». */
export function seriesLine(entry: Extract<CalendarEntry, { kind: "series" }>): string {
  const regions = `в ${plural(entry.regionCount, WORDS.regionPrep)}`;
  return [entry.stage, regions, "даты зависят от региона"].filter(Boolean).join(" · ");
}
