import { describe, expect, it } from "vitest";
import {
  calendarText,
  count,
  formatDate,
  formatDateRange,
  greetingText,
  helpText,
  howItWorksText,
  MAX_TEXT_LENGTH,
  md,
  plural,
  progressText,
  reminderText,
  remindersText,
  subjectLabel,
  WORDS,
} from "@/bot/texts.mjs";
import * as S from "@/bot/screens.mjs";
import { moscowParts, moscowToday, daysBetween, isIsoDate } from "@/bot/time.mjs";
import { olympiad, mock } from "./helpers";

const EMOJI = /\p{Extended_Pictographic}/gu;
const TODAY = "2026-10-01";

describe("Russian plurals", () => {
  it.each([
    [0, "задач"],
    [1, "задача"],
    [2, "задачи"],
    [4, "задачи"],
    [5, "задач"],
    [11, "задач"],
    [12, "задач"],
    [14, "задач"],
    [21, "задача"],
    [22, "задачи"],
    [25, "задач"],
    [101, "задача"],
    [111, "задач"],
    [1004, "задачи"],
  ])("%i → %s", (n, form) => {
    expect(plural(n, WORDS.task)).toBe(form);
  });

  it("formats counts", () => {
    expect(count(3, WORDS.day)).toBe("3 дня");
    expect(count(1, WORDS.point)).toBe("1 балл");
    expect(count(15, WORDS.olympiad)).toBe("15 олимпиад");
  });
});

describe("dates", () => {
  it("renders day and genitive month", () => {
    expect(formatDate("2026-10-14", TODAY)).toBe("14 октября");
    expect(formatDate("2026-03-01", TODAY)).toBe("1 марта");
    expect(formatDate("2026-05-09", TODAY)).toBe("9 мая");
  });

  it("adds the year only when it differs from the current one", () => {
    expect(formatDate("2027-01-20", TODAY)).toBe("20 января 2027");
    expect(formatDate("2026-12-31", TODAY)).toBe("31 декабря");
  });

  it("shows «дата уточняется» for unknown dates", () => {
    expect(formatDate("expected", TODAY)).toBe("дата уточняется");
    expect(formatDate("2026-02-30", TODAY)).toBe("дата уточняется");
  });

  it("renders ranges", () => {
    expect(formatDateRange("2026-10-14", "2026-10-16", TODAY)).toBe("14–16 октября");
    expect(formatDateRange("2026-10-30", "2026-11-02", TODAY)).toBe("30 октября – 2 ноября");
    expect(formatDateRange("2026-12-30", "2027-01-02", TODAY)).toBe("30 декабря – 2 января 2027");
    expect(formatDateRange("2026-10-14", "2026-10-14", TODAY)).toBe("14 октября");
    expect(formatDateRange("2026-10-14", undefined, TODAY)).toBe("14 октября");
  });

  it("computes Moscow wall-clock time independently of the server time zone", () => {
    // 2026-10-01 20:59 UTC is already 23:59 in Moscow; 21:00 UTC is the next day.
    expect(moscowParts(Date.UTC(2026, 9, 1, 20, 59))).toEqual({
      date: "2026-10-01",
      hour: 23,
      minute: 59,
    });
    expect(moscowToday(Date.UTC(2026, 9, 1, 21, 0))).toBe("2026-10-02");
    expect(moscowParts(Date.UTC(2026, 9, 1, 21, 0)).hour).toBe(0);
  });

  it("validates ISO dates and counts days", () => {
    expect(isIsoDate("2026-10-14")).toBe(true);
    expect(isIsoDate("expected")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(daysBetween("2026-10-01", "2026-10-04")).toBe(3);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});

describe("markdown safety", () => {
  it("escapes characters that open MAX markup", () => {
    expect(md("C++ и **жирный** _курсив_ `код` [ссылка](x)")).toBe(
      "C\\+\\+ и \\*\\*жирный\\*\\* \\_курсив\\_ \\`код\\` \\[ссылка\\](x)",
    );
    expect(md("~~зачёркнуто~~ ^^важно^^")).toBe("\\~\\~зачёркнуто\\~\\~ \\^\\^важно\\^\\^");
  });

  it("keeps untrusted text on one line and short", () => {
    expect(md("Маша\n# Заголовок\n> цитата")).toBe("Маша # Заголовок > цитата");
    expect(md("а".repeat(300), 10)).toBe("ааааааааа…");
  });

  it("escapes names in the greeting", () => {
    expect(greetingText({ firstName: "*Маша*" })).toContain("Привет, \\*Маша\\*!");
    expect(greetingText({ firstName: "" })).toMatch(/^Привет! /);
  });
});

describe("subject labels", () => {
  it("names one or both subjects", () => {
    expect(subjectLabel({ subject: "math" })).toBe("математика");
    expect(subjectLabel({ subject: "math", subjects: ["math", "info"] })).toBe(
      "математика и информатика",
    );
  });
});

describe("calendar text", () => {
  it("lists items with dates, scope and registration status", () => {
    const text = calendarText({
      today: TODAY,
      grade: 5,
      region: "Москва",
      items: [
        {
          ...olympiad({ id: "a", title: "ВсОШ – математика", date: "2026-10-12" }),
          editions: 1,
          deadline: "2026-10-05",
        },
        {
          ...olympiad({ id: "b", title: "Школьный этап", region: "Москва", format: "online" }),
          registrationType: "school",
          editions: 1,
        },
        {
          ...olympiad({ id: "c", title: "Прошла регистрация", deadline: "2026-09-20" }),
          editions: 1,
        },
      ],
    });
    expect(text).toContain("**Ближайшие олимпиады**\n5 класс · Москва и вся Россия");
    expect(text).toContain(
      "1. **ВсОШ – математика**\n12 октября · математика · онлайн, вся Россия",
    );
    expect(text).toContain("Регистрация до 5 октября");
    expect(text).toContain("онлайн, Москва\nУчастников регистрирует школа");
    expect(text).toContain("Регистрация завершена");
    expect(text).not.toContain("Укажи класс и регион");
  });

  it("describes collapsed regional series and asks for settings", () => {
    const text = calendarText({
      today: TODAY,
      items: [{ ...olympiad({ id: "s", title: "ВсОШ", region: "Москва" }), editions: 12 }],
    });
    expect(text).toContain("от 20 октября · математика · в 12 регионах, даты зависят от региона");
    expect(text).toContain("вся Россия");
    expect(text).toContain("Укажи класс и регион");
  });

  it("marks demo records", () => {
    const text = calendarText({
      today: TODAY,
      items: [{ ...olympiad({ id: "d", demo: true }), editions: 1 }],
    });
    expect(text).toContain("(учебный пример)");
  });

  it("has an empty state", () => {
    expect(calendarText({ today: TODAY, items: [], grade: 4, region: "Москва" })).toContain(
      "пока нет",
    );
  });
});

describe("progress and reminder texts", () => {
  it("summarises stars, solved tasks, medals, last mock and registrations", () => {
    const text = progressText({
      today: TODAY,
      stars: 3,
      solved: { math: 7, info: 2, total: 9 },
      medals: { earned: 3, total: 10, next: { name: "Мыслитель", subject: "math", remaining: 13 } },
      lastMock: {
        title: "Пробный тур • 5 класс",
        score: 7,
        max: 10,
        finishedAt: Date.UTC(2026, 8, 12, 10),
      },
      upcoming: [{ title: "ВсОШ", date: "2026-10-12" }],
      expected: [{ title: "Математический праздник" }],
    });
    expect(text).toContain("Звёзды за пройденные блоки: 3");
    expect(text).toContain("Решено задач: 9 (математика – 7, информатика – 2)");
    expect(text).toContain("Медали: 3 из 10");
    expect(text).toContain("До медали «Мыслитель» (математика) – ещё 13 задач.");
    expect(text).toContain("«Пробный тур • 5 класс» – 7 из 10 баллов, 12 сентября");
    expect(text).toContain("• 12 октября – ВсОШ");
    expect(text).toContain("• дата уточняется – Математический праздник");
  });

  it("writes D-3 and D-1 reminders", () => {
    const d3 = reminderText({
      kind: "d3",
      title: "ВсОШ",
      date: "2026-10-04",
      today: TODAY,
      hasMock: true,
    });
    expect(d3).toContain("📅 Через 3 дня, **4 октября**, – **«ВсОШ»**.");
    expect(d3).toContain("пробный тур");
    const d1 = reminderText({
      kind: "d1",
      title: "ВсОШ",
      date: "2026-10-02",
      today: TODAY,
      hasMock: false,
    });
    expect(d1).toContain("Завтра, **2 октября**");
    expect(d1).toContain("/reminders");
  });

  it("explains reminders with and without registrations", () => {
    expect(remindersText({ enabled: true, registrations: 2 })).toContain("Напоминания включены");
    expect(remindersText({ enabled: false, registrations: 0 })).toContain(
      "в «Моих олимпиадах» пусто",
    );
  });
});

describe("every screen follows the message rules", () => {
  const ctx = {
    app: { webApp: "olympus_bot", contactId: 1 },
    remindersAvailable: true,
    today: TODAY,
  };
  const longTitle = "Очень длинное название олимпиады ".repeat(20);
  const items = Array.from({ length: 5 }, (_, i) => ({
    olympiad: olympiad({ id: `o${i}`, title: longTitle, region: "Москва" }),
    editions: i === 0 ? 30 : 1,
  }));
  const summary = {
    hasData: true,
    settings: {},
    stars: 99,
    solved: { math: 70, info: 70, total: 140 },
    medals: { earned: 10, total: 10 },
    lastMock: { title: longTitle, score: 1, max: 2 },
    registeredIds: [],
    upcoming: Array.from({ length: 30 }, (_, i) => olympiad({ id: `u${i}`, title: longTitle })),
    expected: [],
  };
  const screens = {
    greeting: S.greetingScreen(ctx, { firstName: "Маша" }),
    menu: S.menuScreen(ctx),
    help: S.helpScreen(ctx),
    unknown: S.unknownScreen(ctx),
    how: S.howItWorksScreen(ctx),
    error: S.errorScreen(ctx),
    calendar: S.calendarScreen(ctx, { items, grade: 5, region: "Москва" }),
    calendarEmpty: S.calendarScreen(ctx, { items: [] }),
    progress: S.progressScreen(ctx, summary),
    progressEmpty: S.progressScreen(ctx, {
      ...summary,
      stars: 0,
      solved: { math: 0, info: 0, total: 0 },
      lastMock: undefined,
      upcoming: [],
    }),
    reminders: S.remindersScreen(ctx, { enabled: true, registrations: 1 }),
    remindersOff: S.remindersScreen(
      { ...ctx, remindersAvailable: false },
      { enabled: false, registrations: 0 },
    ),
    d3: S.reminderScreen(ctx, {
      kind: "d3",
      olympiad: olympiad({ id: "x" }),
      mock: mock({ id: "m" }),
    }),
    d1: S.reminderScreen(ctx, { kind: "d1", olympiad: olympiad({ id: "x" }), mock: null }),
  };

  it.each(Object.entries(screens))("%s: markdown, ≤ 4000 chars, ≤ 1 emoji", (_name, body) => {
    expect(body.format).toBe("markdown");
    expect(body.text!.length).toBeGreaterThan(0);
    expect(body.text!.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect((body.text!.match(EMOJI) ?? []).length).toBeLessThanOrEqual(1);
    for (const b of body.attachments!.flatMap((a) => a.payload.buttons.flat())) {
      expect(b.text.length).toBeLessThanOrEqual(128);
      expect(b.text.match(EMOJI)).toBeNull();
    }
  });

  it("help and how-it-works mention the commands", () => {
    expect(helpText({ remindersAvailable: false })).toContain("/calendar");
    expect(howItWorksText({ remindersAvailable: true })).toContain("/reminders");
    expect(howItWorksText({ remindersAvailable: false })).not.toContain("/reminders");
  });
});
