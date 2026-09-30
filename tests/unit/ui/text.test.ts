import { describe, expect, it } from "vitest";
import { formatNumber, plural, pluralForm, WORDS } from "@/lib/ui/plural";
import {
  gradesLabel,
  isGenericTaskTitle,
  isNumericAnswer,
  priceLabel,
  slugify,
  subjectsLabel,
} from "@/lib/ui/format";
import { normalizeQuery, sameRegion, searchRegions } from "@/lib/ui/regions";
import { regions } from "@/lib/regions";

describe("plural", () => {
  it.each([
    [1, "1 задание"],
    [2, "2 задания"],
    [4, "4 задания"],
    [5, "5 заданий"],
    [11, "11 заданий"],
    [12, "12 заданий"],
    [14, "14 заданий"],
    [21, "21 задание"],
    [22, "22 задания"],
    [25, "25 заданий"],
    [101, "101 задание"],
    [111, "111 заданий"],
    [0, "0 заданий"],
  ])("%i → %s", (n, text) => {
    expect(plural(n, WORDS.task)).toBe(text);
  });

  it("agrees with prepositions and verbs", () => {
    expect(`из ${plural(1, WORDS.pointGen)}`).toBe("из 1 балла");
    expect(`из ${plural(2, WORDS.pointGen)}`).toBe("из 2 баллов");
    expect(`из ${plural(10, WORDS.taskGen)}`).toBe("из 10 заданий");
    expect(`Реши ещё ${plural(1, WORDS.problemAcc)}`).toBe("Реши ещё 1 задачу");
    expect(`Реши ещё ${plural(2, WORDS.problemAcc)}`).toBe("Реши ещё 2 задачи");
    expect(plural(1, WORDS.solvedProblem)).toBe("1 задача решена");
    expect(plural(5, WORDS.solvedProblem)).toBe("5 задач решено");
  });

  it("uses the «few» form for fractions and formats them the Russian way", () => {
    expect(plural(1.5, WORDS.point)).toBe("1,5 балла");
    expect(formatNumber(0.25)).toBe("0,25");
  });

  it("covers the words used on screens", () => {
    expect(plural(1, WORDS.point)).toBe("1 балл");
    expect(plural(3, WORDS.star)).toBe("3 звезды");
    expect(plural(5, WORDS.star)).toBe("5 звёзд");
    expect(plural(45, WORDS.minute)).toBe("45 минут");
    expect(plural(21, WORDS.minute)).toBe("21 минута");
    expect(`в ${plural(86, WORDS.regionPrep)}`).toBe("в 86 регионах");
    expect(`в ${plural(1, WORDS.regionPrep)}`).toBe("в 1 регионе");
    expect(pluralForm(13, WORDS.problem)).toBe("задач");
    expect(pluralForm(Number.NaN, WORDS.problem)).toBe("задач");
  });
});

describe("format", () => {
  it("labels grades naturally", () => {
    expect(gradesLabel([6])).toBe("6 класс");
    expect(gradesLabel([5, 6])).toBe("5 и 6 классы");
    expect(gradesLabel([4, 5, 6])).toBe("4–6 классы");
    expect(gradesLabel([6, 4])).toBe("4 и 6 классы");
    expect(gradesLabel([])).toBe("Классы уточняются");
  });

  it("shows a price only when it is known", () => {
    expect(priceLabel(undefined)).toBeUndefined();
    expect(priceLabel(0)).toBe("Бесплатно");
    expect(priceLabel(160)).toMatch(/^160\s₽$/);
  });

  it("names multi-subject olympiads", () => {
    expect(subjectsLabel({ subject: "math" })).toBe("Математика");
    expect(subjectsLabel({ subject: "math", subjects: ["math", "info"] })).toBe(
      "Математика и информатика",
    );
  });

  it("recognises numeric answers and generic task titles", () => {
    expect(isNumericAnswer("12")).toBe(true);
    expect(isNumericAnswer(" 0,5 ")).toBe(true);
    expect(isNumericAnswer("-3.25")).toBe(true);
    expect(isNumericAnswer("abc")).toBe(false);
    expect(isNumericAnswer("")).toBe(false);
    expect(isGenericTaskTitle("Задание 3")).toBe(true);
    expect(isGenericTaskTitle("Чётные числа до 6")).toBe(false);
  });

  it("makes latin ids from Russian titles", () => {
    expect(slugify("Чётность и нечётность")).toBe("chetnost-i-nechetnost");
    expect(slugify("Олимпиада «Бельчонок» – 2026")).toBe("olimpiada-belchonok-2026");
  });
});

describe("regions", () => {
  it("normalises queries", () => {
    expect(normalizeQuery("  Саха (Якутия) ")).toBe("саха якутия");
    expect(normalizeQuery("Ёлки–Палки")).toBe("елки палки");
    expect(normalizeQuery("Кемеровская область \u2014 Кузбасс")).toBe(
      "кемеровская область кузбасс",
    );
  });

  it("finds official names with an em dash without typing the dash", () => {
    expect(searchRegions("кемеровская область кузбасс", regions)).toEqual([
      "Кемеровская область \u2014 Кузбасс",
    ]);
    expect(sameRegion("Кемеровская область – Кузбасс", "Кемеровская область \u2014 Кузбасс")).toBe(
      true,
    );
  });

  it("finds regions by the start of a word, best matches first", () => {
    expect(searchRegions("мос", regions)[0]).toBe("Москва");
    expect(searchRegions("мос", regions)).toContain("Московская область");
    expect(searchRegions("татар", regions)).toEqual(["Республика Татарстан"]);
  });

  it("understands everyday names", () => {
    expect(searchRegions("питер", regions)[0]).toBe("Санкт-Петербург");
    expect(searchRegions("спб", regions)[0]).toBe("Санкт-Петербург");
    expect(searchRegions("мск", regions)[0]).toBe("Москва");
    expect(searchRegions("хмао", regions)[0]).toBe("Ханты-Мансийский автономный округ — Югра");
    expect(searchRegions("башкирия", regions)[0]).toBe("Республика Башкортостан");
  });

  it("returns the full list for an empty query", () => {
    expect(searchRegions("", regions)).toHaveLength(regions.length);
    expect(searchRegions("zzz", regions)).toEqual([]);
  });

  it("matches region names with official suffixes", () => {
    expect(sameRegion("Чувашская Республика — Чувашия", "Чувашская Республика")).toBe(true);
    expect(sameRegion("Москва", "Московская область")).toBe(false);
    expect(sameRegion("", "Москва")).toBe(false);
  });
});
