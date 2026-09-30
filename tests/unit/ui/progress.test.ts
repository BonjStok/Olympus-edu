import { describe, expect, it } from "vitest";
import type { MockAttempt, ProgressMap, ReviewedTask } from "@/lib/domain/types";
import {
  activeAttempt,
  attemptsForTest,
  bestResult,
  countsAsSolved,
  earnedStars,
  hasPracticeStar,
  hasTheoryStar,
  medalCount,
  medalStates,
  mockTaskCount,
  nextMedal,
  percent,
  readSettings,
  runningAttempt,
  solvedCount,
  starCount,
  taskState,
} from "@/lib/ui/progress";
import {
  entryPart,
  firstUnfinished,
  recommendedTopic,
  splitPrompt,
  tasksToStar,
  topicStatus,
} from "@/lib/ui/learning";
import {
  answeredCount,
  answerText,
  changedAnswers,
  firstMistakeTopic,
  isAnswered,
  mockTitle,
  pendingCount,
  resultStatus,
} from "@/lib/ui/mocks";

const task = (subject: "math" | "info", correct: boolean, extra: object = {}) => ({
  title: "t",
  topicId: "topic",
  subject,
  correct,
  lastCorrect: correct,
  attempts: 1,
  selfChecked: false,
  ...extra,
});

describe("progress", () => {
  const p: ProgressMap = {
    "task:a": task("math", true),
    "task:b": task("math", true, { revealed: true, solvedAfterReveal: true }),
    "task:c": task("info", false),
    "task:d": task("info", true),
    "theory-star:t1": { title: "Чётность", subject: "math", type: "theory", date: 2 },
    "star:t0": { title: "Старая", subject: "math", type: "theory", date: 1 },
    "practice-star:t1": { title: "Чётность", subject: "math", type: "practice", date: 3 },
    "lesson:l1": { read: true },
    settings: { region: "Москва", grade: 5 },
  };

  it("counts only tasks solved without the solution", () => {
    expect(solvedCount(p)).toBe(2);
    expect(solvedCount(p, "math")).toBe(1);
    expect(solvedCount(p, "info")).toBe(1);
    expect(countsAsSolved(undefined)).toBe(false);
    expect(taskState(p, "a")).toBe("solved");
    expect(taskState(p, "b")).toBe("solved-after-reveal");
    expect(taskState(p, "c")).toBe("wrong");
    expect(taskState(p, "zzz")).toBe("new");
  });

  it("counts stars, including the legacy key", () => {
    expect(starCount(p)).toBe(3);
    expect(hasTheoryStar(p, "t0")).toBe(true);
    expect(hasTheoryStar(p, "t1")).toBe(true);
    expect(hasPracticeStar(p, "t1")).toBe(true);
    expect(earnedStars(p).map((s) => s.key)).toEqual([
      "practice-star:t1",
      "theory-star:t1",
      "star:t0",
    ]);
  });

  it("awards medals and says how far the next one is", () => {
    expect(
      medalStates(5)
        .filter((m) => m.earned)
        .map((m) => m.name),
    ).toEqual(["Первый шаг", "Исследователь"]);
    expect(nextMedal(0)).toEqual({ name: "Первый шаг", left: 1 });
    expect(nextMedal(12)).toEqual({ name: "Мыслитель", left: 3 });
    expect(nextMedal(60)).toBeNull();
    expect(medalCount(p)).toBe(2);
  });

  it("reads settings stored on the server", () => {
    expect(readSettings(p)).toEqual({ region: "Москва", grade: 5 });
    expect(readSettings({})).toEqual({});
  });

  it("finds attempts, the running one and the best result", () => {
    const now = 1_000_000;
    const a = (id: string, patch: Partial<MockAttempt>): MockAttempt =>
      ({
        id,
        testId: "m1",
        title: "Тур",
        subject: "math",
        started: 1,
        ends: now + 60_000,
        tasks: [],
        answers: {},
        finished: false,
        ...patch,
      }) as MockAttempt;
    const progress: ProgressMap = {
      "attempt:1": a("1", { finished: true, score: 3, max: 10, started: 1 }),
      "attempt:2": a("2", { finished: true, score: 7, max: 10, started: 2 }),
      "attempt:3": a("3", { started: 3 }),
      "attempt:4": a("4", { started: 4, ends: now - 1 }),
    };
    expect(attemptsForTest(progress, "m1").map((x) => x.id)).toEqual(["4", "3", "2", "1"]);
    expect(activeAttempt(progress, "m1", now)?.id).toBe("3");
    expect(runningAttempt(progress, now)?.id).toBe("3");
    expect(bestResult(attemptsForTest(progress, "m1"))).toEqual({ score: 7, max: 10 });
    expect(percent(7, 10)).toBe(70);
    expect(percent(1, 0)).toBe(0);
  });

  it("counts mock tasks like the server does", () => {
    expect(mockTaskCount({ taskIds: ["a", "b", "c"], randomize: false })).toBe(3);
    expect(mockTaskCount({ taskIds: ["a", "b", "c"], randomize: true, taskCount: 2 })).toBe(2);
    expect(
      mockTaskCount({ taskIds: new Array(20).fill("x"), randomize: true, taskCount: 10 }),
    ).toBe(10);
  });
});

describe("learning path", () => {
  const lessons = [{ id: "l1" }, { id: "l2" }];
  const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("summarises a topic", () => {
    const p: ProgressMap = { "lesson:l1": { read: true }, "task:a": task("math", true) };
    const s = topicStatus("t", lessons, tasks, p);
    expect(s).toMatchObject({
      lessonsRead: 1,
      lessonsTotal: 2,
      solved: 1,
      tasksTotal: 4,
      started: true,
      done: false,
    });
    expect(tasksToStar(s)).toBe(2);
    expect(entryPart(s)).toBe("theory");
    expect(entryPart({ ...s, theoryStar: true })).toBe("practice");
  });

  it("recommends the first unfinished topic, preferring a started one", () => {
    const status = (id: string) =>
      ({
        a: { done: true, started: true },
        b: { done: false, started: false },
        c: { done: false, started: true },
      })[id] as ReturnType<typeof topicStatus>;
    expect(recommendedTopic([{ id: "a" }, { id: "b" }, { id: "c" }], status)?.id).toBe("c");
    expect(recommendedTopic([{ id: "a" }, { id: "b" }], status)?.id).toBe("b");
    expect(recommendedTopic([{ id: "a" }], status)).toBeUndefined();
  });

  it("resumes at the first unfinished item", () => {
    expect(firstUnfinished(tasks, (id) => id === "a" || id === "b")).toBe(2);
    expect(firstUnfinished(tasks, () => true)).toBe(0);
  });

  it("splits prompts with fenced code", () => {
    expect(
      splitPrompt("Что выведет программа?\n```python\nprint(2 + 3)\n```\nОтвет – число."),
    ).toEqual([
      { type: "text", value: "Что выведет программа?" },
      { type: "code", value: "print(2 + 3)", lang: "python" },
      { type: "text", value: "Ответ – число." },
    ]);
    expect(splitPrompt("Просто текст")).toEqual([{ type: "text", value: "Просто текст" }]);
  });
});

describe("mocks", () => {
  const tasks = [
    { id: "n", type: "number", topicId: "t1" },
    { id: "c", type: "code", topicId: "t2" },
    { id: "p", type: "proof", topicId: "t3" },
  ] as unknown as ReviewedTask[];

  it("derives result statuses for old attempts", () => {
    expect(resultStatus({ id: "n", correct: true, points: 1, max: 1, note: "" }, tasks[0])).toBe(
      "correct",
    );
    expect(resultStatus({ id: "n", correct: false, points: 0, max: 1, note: "" }, tasks[0])).toBe(
      "wrong",
    );
    expect(
      resultStatus(
        {
          id: "c",
          correct: false,
          points: 0,
          max: 1,
          note: "Judge0 не настроен: задайте JUDGE0_URL",
        },
        tasks[1],
      ),
    ).toBe("unchecked");
    expect(
      resultStatus(
        { id: "p", correct: false, points: 0, max: 1, note: "Самопроверка после завершения" },
        tasks[2],
      ),
    ).toBe("self-check");
    expect(
      resultStatus(
        { id: "p", correct: false, points: 0, max: 1, note: "", status: "wrong" },
        tasks[2],
      ),
    ).toBe("wrong");
  });

  it("counts pending and answered tasks", () => {
    const attempt = {
      tasks,
      answers: { n: "12", c: { code: "  ", language: "python" }, p: "" },
      results: [
        { id: "n", correct: false, points: 0, max: 1, note: "" },
        { id: "c", correct: false, points: 0, max: 1, note: "", status: "unchecked" },
        { id: "p", correct: false, points: 0, max: 1, note: "Самопроверка после завершения" },
      ],
    } as unknown as MockAttempt<ReviewedTask>;
    expect(pendingCount(attempt)).toBe(1);
    expect(pendingCount({ ...attempt, pending: 4 })).toBe(4);
    expect(answeredCount(attempt)).toBe(1);
    expect(firstMistakeTopic(attempt)).toBe("t1");
    expect(isAnswered(undefined)).toBe(false);
    expect(answerText({ code: "print(1)", language: "python" })).toBe("print(1)");
  });

  it("sends only changed answers, with removals as empty strings", () => {
    expect(changedAnswers({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })).toEqual({
      b: "3",
      c: "4",
    });
    expect(changedAnswers({ a: "1" }, {})).toEqual({ a: "" });
    expect(
      changedAnswers(
        { a: { code: "x", language: "python" } },
        { a: { code: "x", language: "python" } },
      ),
    ).toEqual({});
  });

  it("always shows the subject in mock titles", () => {
    expect(mockTitle({ title: "Пробный тур • 4 класс", subject: "math" })).toBe(
      "Пробный тур · Математика · 4 класс",
    );
    expect(mockTitle({ title: "Тур по информатике", subject: "info" })).toBe("Тур по информатике");
    expect(mockTitle({ title: "Олимпиада", subject: "info" })).toBe("Олимпиада · Информатика");
  });
});
