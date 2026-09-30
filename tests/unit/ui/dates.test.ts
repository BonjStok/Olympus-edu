import { describe, expect, it } from "vitest";
import {
  addMonths,
  daysBetween,
  formatCountdown,
  formatDateTime,
  formatDay,
  formatMonth,
  formatRange,
  isExpectedDate,
  isIsoDay,
  monthGrid,
  relativeDays,
  todayIso,
} from "@/lib/ui/dates";

describe("dates", () => {
  it("treats empty and «expected» values as not announced", () => {
    for (const v of [undefined, null, "", "expected", "Ожидается", " pending "])
      expect(isExpectedDate(v)).toBe(true);
    expect(isExpectedDate("2026-10-20")).toBe(false);
    expect(isIsoDay("2026-10-20")).toBe(true);
    expect(isIsoDay("20.10.2026")).toBe(false);
  });

  it("returns today in Moscow", () => {
    // 22:30 UTC on Sep 29 is already Sep 30 in Moscow.
    expect(todayIso(new Date("2026-09-29T22:30:00Z"))).toBe("2026-09-30");
  });

  it("formats days and adds the year only when it differs", () => {
    expect(formatDay("2026-10-20", 2026)).toBe("20 октября");
    expect(formatDay("2027-01-12", 2026)).toBe("12 января 2027");
    expect(formatDay("2026-11-10", 2026, true)).toBe("10 нояб");
    expect(formatDay("expected")).toBe("Ожидается");
  });

  it("formats ranges", () => {
    expect(formatRange("2026-10-20", "2026-10-25", 2026)).toBe("20–25 октября");
    expect(formatRange("2026-09-30", "2026-10-02", 2026)).toBe("30 сентября – 2 октября");
    expect(formatRange("2026-10-20", "2026-11-10", 2026, true)).toBe("20 окт – 10 нояб");
    expect(formatRange("2026-10-01", "2027-01-12", 2026, true)).toBe("1 окт – 12 янв 2027");
    expect(formatRange("2026-10-20", undefined, 2026)).toBe("20 октября");
    expect(formatRange("expected")).toBe("Ожидается");
  });

  it("formats months without «г.»", () => {
    expect(formatMonth(2026, 9)).toBe("Октябрь 2026");
  });

  it("counts days and says them in words", () => {
    expect(daysBetween("2026-09-29", "2026-10-13")).toBe(14);
    expect(daysBetween("2026-10-13", "2026-09-29")).toBe(-14);
    expect(relativeDays(0)).toBe("сегодня");
    expect(relativeDays(1)).toBe("завтра");
    expect(relativeDays(5)).toBe("через 5 дней");
    expect(relativeDays(-3)).toBe("3 дня назад");
    expect(relativeDays(21)).toBe("через 21 день");
  });

  it("formats the mock timer", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(45 * 60_000)).toBe("45:00");
    expect(formatCountdown(60 * 60_000)).toBe("60:00");
    expect(formatCountdown(75 * 60_000)).toBe("75:00");
    expect(formatCountdown(3_723_000)).toBe("62:03");
    expect(formatCountdown(100 * 60_000)).toBe("1:40:00");
    expect(formatCountdown(-5)).toBe("00:00");
    expect(formatCountdown(500)).toBe("00:01");
  });

  it("formats timestamps", () => {
    const now = new Date(2026, 8, 29, 18, 0);
    expect(formatDateTime(new Date(2026, 8, 29, 16, 5).getTime(), now)).toBe("29 сентября, 16:05");
    expect(formatDateTime(new Date(2025, 0, 2, 9, 0).getTime(), now)).toBe("2 января 2025, 09:00");
  });

  it("lays out a month Monday-first", () => {
    const cells = monthGrid(2026, 9); // October 2026 starts on Thursday
    expect(cells.slice(0, 3).every((c) => c.iso === null)).toBe(true);
    expect(cells[3]).toEqual({ iso: "2026-10-01", day: 1 });
    expect(cells.filter((c) => c.iso)).toHaveLength(31);
  });

  it("moves between months across years", () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});
