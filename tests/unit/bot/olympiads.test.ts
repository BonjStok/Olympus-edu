import { describe, expect, it } from "vitest";
import {
  isUpcoming,
  normalizeMockTest,
  normalizeOlympiad,
  pickMockTest,
  selectUpcoming,
} from "@/bot/olympiads.mjs";
import { mock, olympiad } from "./helpers";

const TODAY = "2026-10-01";

const catalog = [
  olympiad({ id: "past", date: "2026-09-20", title: "Прошедшая" }),
  olympiad({ id: "today", date: "2026-10-01", title: "Сегодня" }),
  olympiad({ id: "multi", date: "2026-09-29", dateEnd: "2026-10-03", title: "Идёт сейчас" }),
  olympiad({ id: "expected", date: "expected", title: "Дата неизвестна" }),
  olympiad({ id: "national", date: "2026-10-10", title: "Всероссийская", grades: [5, 6] }),
  olympiad({ id: "grade4", date: "2026-10-11", title: "Для четвероклассников", grades: [4] }),
  olympiad({ id: "moscow-local", date: "2026-10-05", region: "Москва", title: "Московская" }),
  olympiad({
    id: "vsosh-moscow",
    date: "2026-10-12",
    region: "Москва",
    series: "vsosh-school-2026-math",
    title: "ВсОШ – математика – школьный этап",
  }),
  olympiad({
    id: "vsosh-spb",
    date: "2026-10-08",
    region: "Санкт-Петербург",
    series: "vsosh-school-2026-math",
    title: "ВсОШ – математика – школьный этап",
  }),
  olympiad({
    id: "vsosh-kazan",
    date: "2026-10-15",
    region: "Республика Татарстан",
    series: "vsosh-school-2026-math",
    title: "ВсОШ – математика – школьный этап",
  }),
  olympiad({ id: "later", date: "2026-11-20", title: "Поздняя" }),
];

describe("upcoming olympiads", () => {
  it("excludes past olympiads and those without a concrete date", () => {
    expect(isUpcoming(catalog[0], TODAY)).toBe(false);
    expect(isUpcoming(catalog[1], TODAY)).toBe(true);
    expect(isUpcoming(catalog[2], TODAY)).toBe(true); // multi-day event still running
    expect(isUpcoming(catalog[3], TODAY)).toBe(false);
  });

  it("without settings: all-Russia events plus collapsed regional series, sorted by date", () => {
    const { items, total } = selectUpcoming(catalog, { today: TODAY, limit: 10 });
    expect(items.map((i) => i.olympiad.id)).toEqual([
      "multi",
      "today",
      "vsosh-spb", // earliest edition represents the series
      "national",
      "grade4",
      "later",
    ]);
    const series = items.find((i) => i.olympiad.series);
    expect(series?.editions).toBe(3);
    expect(items.some((i) => i.olympiad.id === "moscow-local")).toBe(false);
    expect(total).toBe(6);
  });

  it("with a region: national events and that region's editions, not collapsed", () => {
    const { items } = selectUpcoming(catalog, { today: TODAY, region: "Москва", limit: 10 });
    const ids = items.map((i) => i.olympiad.id);
    expect(ids).toContain("moscow-local");
    expect(ids).toContain("vsosh-moscow");
    expect(ids).not.toContain("vsosh-spb");
    expect(ids).not.toContain("vsosh-kazan");
    expect(items.every((i) => i.editions === 1)).toBe(true);
  });

  it("with a grade: only olympiads for that grade", () => {
    const { items } = selectUpcoming(catalog, { today: TODAY, grade: 4, limit: 10 });
    const ids = items.map((i) => i.olympiad.id);
    expect(ids).toContain("grade4");
    expect(ids).not.toContain("national");
  });

  it("returns at most `limit` items (5 by default)", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      olympiad({ id: `o${i}`, date: `2026-10-${String(10 + i).padStart(2, "0")}` }),
    );
    const { items, total } = selectUpcoming(many, { today: TODAY });
    expect(items).toHaveLength(5);
    expect(items[0].olympiad.id).toBe("o0");
    expect(total).toBe(12);
  });

  it("puts featured olympiads first on the same day", () => {
    const { items } = selectUpcoming(
      [
        olympiad({ id: "a", date: "2026-10-10", title: "А" }),
        olympiad({ id: "b", date: "2026-10-10", title: "Б", featured: true }),
      ],
      { today: TODAY },
    );
    expect(items.map((i) => i.olympiad.id)).toEqual(["b", "a"]);
  });
});

describe("record normalisation", () => {
  it("skips unpublished and broken records", () => {
    expect(normalizeOlympiad({ id: "x", title: "T", unpublished: true })).toBeNull();
    expect(normalizeOlympiad({ id: "", title: "T" })).toBeNull();
    expect(normalizeOlympiad(null)).toBeNull();
    expect(normalizeMockTest({ id: "m", title: "M", unpublished: true })).toBeNull();
  });

  it("fills defaults for legacy records without region/series", () => {
    const o = normalizeOlympiad({
      id: "x",
      title: " T ",
      subject: "math",
      grades: ["5"],
      date: "2026-10-10",
    });
    expect(o).toMatchObject({ id: "x", title: "T", region: "", grades: [5], series: undefined });
  });
});

describe("mock test for a reminder", () => {
  const mocks = [
    mock({ id: "m4", grade: 4, subject: "math", olympiad: "Учебный тур Олимпуса" }),
    mock({ id: "m5", grade: 5, subject: "math", olympiad: "Учебный тур Олимпуса" }),
    mock({ id: "i5", grade: 5, subject: "info", olympiad: "Учебный тур Олимпуса" }),
    mock({ id: "max5", grade: 5, subject: "math", olympiad: "Олимпиада MAX" }),
    mock({ id: "max6", grade: 6, subject: "math", olympiad: "Олимпиада MAX" }),
  ];

  it("prefers a mock prepared for this olympiad and the child's grade", () => {
    const o = olympiad({ id: "max", title: "Олимпиада MAX по математике" });
    expect(pickMockTest(o, mocks, 5)?.id).toBe("max5");
    expect(pickMockTest(o, mocks, 6)?.id).toBe("max6");
  });

  it("falls back to a general mock of the subject for the child's grade", () => {
    const o = olympiad({ id: "other", title: "Турнир городов", subject: "info" });
    expect(pickMockTest(o, mocks, 5)?.id).toBe("i5");
  });

  it("returns null when the grade is unknown and several grades fit", () => {
    const o = olympiad({ id: "max", title: "Олимпиада MAX" });
    expect(pickMockTest(o, mocks, undefined)).toBeNull();
    expect(pickMockTest(olympiad({ id: "o", title: "Другая" }), mocks, undefined)).toBeNull();
  });

  it("respects the olympiad's grades", () => {
    const o = olympiad({ id: "g6", title: "Олимпиада MAX", grades: [6] });
    expect(pickMockTest(o, mocks, undefined)?.id).toBe("max6");
  });
});
