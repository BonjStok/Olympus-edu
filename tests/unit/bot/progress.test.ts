import { describe, expect, it } from "vitest";
import {
  MEDAL_THRESHOLDS,
  parseSettings,
  registeredOlympiadIds,
  summarizeProgress,
} from "@/bot/progress.mjs";
import { MEDALS } from "@/lib/domain/achievements.mjs";
import { olympiad } from "./helpers";

const TODAY = "2026-10-01";

function rows(map: Record<string, unknown>) {
  return Object.entries(map).map(([key, data]) => ({ key, data }));
}

describe("progress summary", () => {
  const olympiads = new Map(
    [
      olympiad({ id: "soon", date: "2026-10-12", title: "Скоро" }),
      olympiad({ id: "later", date: "2026-11-01", title: "Позже" }),
      olympiad({ id: "past", date: "2026-09-01", title: "Прошла" }),
      olympiad({ id: "tbd", date: "expected", title: "Без даты" }),
    ].map((o) => [o.id, o]),
  );

  const progress = rows({
    "theory-star:t1": { title: "T1", subject: "math", type: "theory", date: 1 },
    "practice-star:t1": { title: "T1", subject: "math", type: "practice", date: 2 },
    "star:legacy": { title: "Old", subject: "info", type: "theory", date: 3 },
    "task:a": { subject: "math", correct: true, lastCorrect: true, attempts: 1 },
    "task:b": { subject: "math", correct: true, lastCorrect: false, attempts: 3 },
    "task:c": { subject: "math", correct: false, lastCorrect: false, attempts: 2 },
    "task:d": { subject: "info", correct: true, lastCorrect: true, attempts: 1 },
    "attempt:1": { title: "Тур 1", finished: true, finishedAt: 1000, score: 3, max: 10 },
    "attempt:2": { title: "Тур 2", finished: true, finishedAt: 5000, score: 8, max: 10 },
    "attempt:3": { title: "Незакончен", finished: false, started: 9000, score: 0, max: 10 },
    "registration:later": { registered: true },
    "registration:soon": { registered: true },
    "registration:past": { registered: true },
    "registration:tbd": { registered: true },
    "registration:gone": { registered: true },
    "registration:off": { registered: false },
    "lesson:l1": { read: true },
    settings: { region: "Москва", grade: 5, subject: "info" },
  });

  const summary = summarizeProgress(progress, olympiads, TODAY);

  it("counts stars like the profile screen (theory, practice and legacy keys)", () => {
    expect(summary.stars).toBe(3);
  });

  it("counts correctly solved tasks per subject", () => {
    expect(summary.solved).toEqual({ math: 2, info: 1, total: 3 });
  });

  it("computes medals with the app thresholds and the closest next medal", () => {
    expect(MEDAL_THRESHOLDS).toEqual(MEDALS.map((m) => m.threshold));
    expect(summary.medals.earned).toBe(2); // one per subject (≥ 1 solved)
    expect(summary.medals.total).toBe(10);
    expect(summary.medals.next).toEqual({ name: "Исследователь", subject: "math", remaining: 3 });
  });

  it("does not count tasks solved only after opening the solution", () => {
    const own = summarizeProgress(
      rows({
        "task:a": { subject: "math", correct: true },
        "task:b": { subject: "math", correct: true, solvedAfterReveal: true },
        "task:c": { subject: "info", correct: false },
      }),
      olympiads,
      TODAY,
    );
    expect(own.solved).toEqual({ math: 1, info: 0, total: 1 });
  });

  it("takes the latest finished mock test", () => {
    expect(summary.lastMock).toEqual({ title: "Тур 2", score: 8, max: 10, finishedAt: 5000 });
  });

  it("lists «Мои олимпиады»: upcoming by date, then without a date; past and unknown skipped", () => {
    expect(summary.upcoming.map((o) => o.id)).toEqual(["soon", "later"]);
    expect(summary.expected.map((o) => o.id)).toEqual(["tbd"]);
    expect(summary.registeredIds.sort()).toEqual(["gone", "later", "past", "soon", "tbd"]);
  });

  it("reads the app settings", () => {
    expect(summary.settings).toEqual({ region: "Москва", grade: 5, subject: "info" });
    expect(summary.hasData).toBe(true);
  });

  it("handles a user without any progress", () => {
    const empty = summarizeProgress([], olympiads, TODAY);
    expect(empty).toMatchObject({
      hasData: false,
      stars: 0,
      solved: { total: 0 },
      medals: { earned: 0, next: { name: "Первый шаг", remaining: 1 } },
      lastMock: undefined,
      upcoming: [],
      expected: [],
    });
  });

  it("ignores malformed values", () => {
    const broken = summarizeProgress(
      rows({ "task:x": null, "attempt:y": "oops", "registration:z": [], settings: 5 }),
      olympiads,
      TODAY,
    );
    expect(broken.solved.total).toBe(0);
    expect(broken.lastMock).toBeUndefined();
    expect(broken.registeredIds).toEqual([]);
    expect(broken.settings).toEqual({});
  });
});

describe("settings and registrations", () => {
  it("accepts only valid grades and subjects", () => {
    expect(parseSettings({ grade: "6", region: " Москва ", subject: "x" })).toEqual({
      grade: 6,
      region: "Москва",
    });
    expect(parseSettings({ grade: 9 })).toEqual({});
  });

  it("lists registered olympiad ids", () => {
    expect(
      registeredOlympiadIds(
        rows({ "registration:a": { registered: true }, "registration:b": {}, "task:a": {} }),
      ),
    ).toEqual(["a"]);
  });
});
