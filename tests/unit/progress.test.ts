import { describe, expect, it } from "vitest";
import { countsAsSolved, PRACTICE_STAR_GOAL } from "@/lib/domain/achievements.mjs";
import type { MockAttempt, Task, TaskProgress } from "@/lib/domain/types";
import type { Db } from "@/lib/server/db";
import {
  mergeProgressValue,
  mergeUserProgress,
  progressKey,
  progressMap,
  sanitizeAttempt,
  sanitizeProgressValue,
  saveProgress,
} from "@/lib/services/progress";
import { earnsPracticeStar, unreadLessons } from "@/lib/services/stars";
import { nextTaskProgress, revealedTaskProgress } from "@/lib/services/tasks";

const OLD = 1_000;
const NEW = 2_000;

const taskProgress = (extra: Partial<TaskProgress> = {}): TaskProgress => ({
  title: "Задание",
  topicId: "math-4-01",
  subject: "math",
  correct: false,
  lastCorrect: false,
  attempts: 1,
  selfChecked: false,
  ...extra,
});

describe("progressKey", () => {
  it("builds the documented keys", () => {
    expect(progressKey.lesson("l")).toBe("lesson:l");
    expect(progressKey.task("t")).toBe("task:t");
    expect(progressKey.code("t")).toBe("code:t");
    expect(progressKey.registration("o")).toBe("registration:o");
    expect(progressKey.theoryStar("x")).toBe("theory-star:x");
    expect(progressKey.legacyStar("x")).toBe("star:x");
    expect(progressKey.practiceStar("x")).toBe("practice-star:x");
    expect(progressKey.attempt("a")).toBe("attempt:a");
    expect(progressKey.settings).toBe("settings");
  });
});

describe("mergeProgressValue", () => {
  it("takes the side that exists", () => {
    expect(mergeProgressValue("task:t", { a: 1 }, null, OLD, NEW)).toEqual({ a: 1 });
    expect(mergeProgressValue("task:t", undefined, { b: 2 }, OLD, NEW)).toEqual({ b: 2 });
  });

  it("task: never loses a solve, keeps max attempts and the newer last result", () => {
    const guest = taskProgress({ correct: true, lastCorrect: true, attempts: 2 });
    const max = taskProgress({ correct: false, lastCorrect: false, attempts: 5 });
    expect(mergeProgressValue("task:t", guest, max, OLD, NEW)).toEqual(
      taskProgress({ correct: true, lastCorrect: false, attempts: 5 }),
    );
    expect(mergeProgressValue("task:t", guest, max, NEW, OLD)).toMatchObject({
      correct: true,
      lastCorrect: true,
      attempts: 5,
    });
  });

  it("task: self-checked flag is sticky", () => {
    const merged = mergeProgressValue(
      "task:t",
      taskProgress({ selfChecked: true }),
      taskProgress(),
      OLD,
      NEW,
    );
    expect(merged).toMatchObject({ selfChecked: true });
  });

  it("task: a clean solve on either side clears the reveal marks", () => {
    const clean = taskProgress({ correct: true, lastCorrect: true });
    const afterReveal = taskProgress({ correct: true, revealed: true, solvedAfterReveal: true });
    for (const [a, b] of [
      [clean, afterReveal],
      [afterReveal, clean],
    ]) {
      const merged = mergeProgressValue("task:t", a, b, NEW, OLD) as TaskProgress;
      expect(merged.correct).toBe(true);
      expect(merged).not.toHaveProperty("solvedAfterReveal");
      expect(merged).not.toHaveProperty("revealed");
    }
  });

  it("task: revealed-but-unsolved on one side does not spoil a clean solve on the other", () => {
    const merged = mergeProgressValue(
      "task:t",
      taskProgress({ revealed: true }),
      taskProgress({ correct: true }),
      NEW,
      OLD,
    );
    expect(merged).not.toHaveProperty("revealed");
    expect(merged).not.toHaveProperty("solvedAfterReveal");
  });

  it("task: solved after reveal on both sides stays solved after reveal", () => {
    const side = taskProgress({ correct: true, revealed: true, solvedAfterReveal: true });
    expect(mergeProgressValue("task:t", side, { ...side }, OLD, NEW)).toMatchObject({
      correct: true,
      revealed: true,
      solvedAfterReveal: true,
    });
  });

  it("task: solved after reveal on one side and unsolved on the other stays marked", () => {
    const merged = mergeProgressValue(
      "task:t",
      taskProgress({ correct: true, revealed: true, solvedAfterReveal: true }),
      taskProgress({ attempts: 4 }),
      OLD,
      NEW,
    );
    expect(merged).toMatchObject({ correct: true, solvedAfterReveal: true, revealed: true });
  });

  it("task: neither side solved keeps the revealed mark", () => {
    const merged = mergeProgressValue(
      "task:t",
      taskProgress(),
      taskProgress({ revealed: true }),
      NEW,
      OLD,
    );
    expect(merged).toMatchObject({ correct: false, revealed: true });
    expect(merged).not.toHaveProperty("solvedAfterReveal");
  });

  it("lesson and registration flags are OR-ed", () => {
    expect(mergeProgressValue("lesson:l", { read: true }, { read: false }, OLD, NEW)).toEqual({
      read: true,
    });
    expect(
      mergeProgressValue("registration:o", { registered: false }, { registered: true }, NEW, OLD),
    ).toEqual({ registered: true });
  });

  it.each(["star:x", "theory-star:x", "practice-star:x"])("%s keeps the earliest date", (key) => {
    const merged = mergeProgressValue(
      key,
      { title: "Новая", date: 500 },
      { title: "Старая", date: 300 },
      NEW,
      OLD,
    );
    expect(merged).toEqual({ title: "Новая", date: 300 });
    expect(mergeProgressValue(key, { date: 0 }, { title: "x" }, NEW, OLD)).toEqual({
      title: "x",
      date: 0,
    });
  });

  it("settings merge field by field, newer wins", () => {
    const guest = { grade: 6, region: "" };
    const max = { grade: 4, subject: "math" };
    expect(mergeProgressValue("settings", guest, max, NEW, OLD)).toEqual({
      grade: 6,
      subject: "math",
      region: "",
    });
    expect(mergeProgressValue("settings", guest, max, OLD, NEW)).toEqual({
      grade: 4,
      subject: "math",
      region: "",
    });
  });

  it("anything else: the newer value wins as a whole (ties go to the guest)", () => {
    const guest = { code: "print(1)", language: "python" };
    const max = { code: "print(2)", language: "python" };
    expect(mergeProgressValue("code:t", guest, max, OLD, NEW)).toBe(max);
    expect(mergeProgressValue("code:t", guest, max, NEW, OLD)).toBe(guest);
    expect(mergeProgressValue("attempt:a", guest, max, NEW, NEW)).toBe(guest);
  });
});

const fullTask: Task = {
  id: "t1",
  kind: "tasks",
  title: "Задание",
  grade: 4,
  subject: "info",
  topicId: "info-4-01",
  order: 1,
  type: "code",
  prompt: "Сложи",
  answer: "42",
  solution: "Разбор",
  hint: "Подсказка",
  tests: [{ input: "1", output: "2" }],
  example: { input: "0", output: "1" },
};

const attempt = (finished: boolean): MockAttempt<Task> => ({
  id: "a1",
  testId: "m1",
  title: "Пробник",
  subject: "info",
  started: 1,
  ends: 2,
  tasks: [fullTask],
  answers: {},
  finished,
});

describe("sanitizeAttempt / sanitizeProgressValue", () => {
  it("hides answers, solutions, hints and hidden tests of an unfinished attempt", () => {
    const [task] = sanitizeAttempt(attempt(false)).tasks;
    expect(task).not.toHaveProperty("answer");
    expect(task).not.toHaveProperty("solution");
    expect(task).not.toHaveProperty("hint");
    expect(task).not.toHaveProperty("tests");
    expect(task).toMatchObject({ prompt: "Сложи", example: { input: "0", output: "1" } });
  });

  it("reveals answers after finishing but never the hidden tests", () => {
    const [task] = sanitizeAttempt(attempt(true)).tasks;
    expect(task).toMatchObject({ answer: "42", solution: "Разбор", hint: "Подсказка" });
    expect(task).not.toHaveProperty("tests");
  });

  it("only touches attempt keys that contain tasks", () => {
    const value = attempt(false);
    expect(sanitizeProgressValue("attempt:a1", value)).not.toBe(value);
    expect(sanitizeProgressValue("code:t1", value)).toBe(value);
    expect(sanitizeProgressValue("attempt:a1", { finished: true })).toEqual({ finished: true });
    expect(sanitizeProgressValue("attempt:a1", null)).toBeNull();
  });

  it("progressMap keeps the last value of each key", () => {
    expect(
      progressMap([
        { key: "a", value: 1, updated: 1 },
        { key: "b", value: 2, updated: 2 },
      ]),
    ).toEqual({ a: 1, b: 2 });
  });
});

describe("stars", () => {
  it("practice star needs the shared goal of clean solves and is awarded once", () => {
    expect(PRACTICE_STAR_GOAL).toBe(3);
    expect(earnsPracticeStar(PRACTICE_STAR_GOAL - 1, false)).toBe(false);
    expect(earnsPracticeStar(PRACTICE_STAR_GOAL, false)).toBe(true);
    expect(earnsPracticeStar(PRACTICE_STAR_GOAL + 7, true)).toBe(false);
  });

  it("theory star needs every lesson read", () => {
    const read = new Set(["lesson:l1", "lesson:l3", "task:l2"]);
    expect(unreadLessons(["l1", "l2", "l3"], read)).toEqual(["l2"]);
    expect(unreadLessons(["l1", "l3"], read)).toEqual([]);
  });
});

describe("task progress after checks and reveals", () => {
  const info = {
    title: "Задание",
    topicId: "math-4-01",
    subject: "math" as const,
    type: "number" as const,
  };

  it("counts attempts and keeps an earlier solve", () => {
    const first = nextTaskProgress(info, null, false);
    expect(first).toEqual(taskProgress({ attempts: 1 }));
    const second = nextTaskProgress(info, first, true);
    expect(second).toEqual(taskProgress({ correct: true, lastCorrect: true, attempts: 2 }));
    expect(nextTaskProgress(info, second, false)).toMatchObject({
      correct: true,
      lastCorrect: false,
      attempts: 3,
    });
  });

  it("marks proofs as self-checked", () => {
    expect(nextTaskProgress({ ...info, type: "proof" }, null, true).selfChecked).toBe(true);
  });

  it("a first solve after a reveal is solvedAfterReveal", () => {
    const revealed = revealedTaskProgress(info, null)!;
    expect(revealed).toEqual(taskProgress({ attempts: 0, revealed: true }));
    const solved = nextTaskProgress(info, revealed, true);
    expect(solved).toMatchObject({ correct: true, revealed: true, solvedAfterReveal: true });
    expect(nextTaskProgress(info, solved, true).solvedAfterReveal).toBe(true);
  });

  it("a wrong answer after a reveal is not marked solved", () => {
    const next = nextTaskProgress(info, revealedTaskProgress(info, null), false);
    expect(next).toMatchObject({ correct: false, revealed: true });
    expect(next).not.toHaveProperty("solvedAfterReveal");
  });

  it("revealing keeps the previous attempts and does nothing for solved tasks", () => {
    const tried = taskProgress({ attempts: 3, lastCorrect: false });
    expect(revealedTaskProgress(info, tried)).toMatchObject({ attempts: 3, revealed: true });
    expect(revealedTaskProgress(info, taskProgress({ correct: true }))).toBeNull();
  });

  it("a clean earlier solve stays clean after a later reveal attempt", () => {
    const clean = nextTaskProgress(info, null, true);
    expect(nextTaskProgress(info, clean, true)).not.toHaveProperty("solvedAfterReveal");
  });
});

describe("shared achievement rules on the server", () => {
  const variants: Partial<TaskProgress>[] = [
    { correct: false },
    { correct: true },
    { correct: true, revealed: true },
    { correct: true, revealed: true, solvedAfterReveal: true },
    { correct: false, revealed: true },
  ];

  it("a merged task is a clean solve exactly when countsAsSolved says so for one side", () => {
    for (const a of variants)
      for (const b of variants) {
        const merged = mergeProgressValue(
          "task:t",
          taskProgress(a),
          taskProgress(b),
          OLD,
          NEW,
        ) as TaskProgress;
        const clean = countsAsSolved(taskProgress(a)) || countsAsSolved(taskProgress(b));
        expect(countsAsSolved(merged), JSON.stringify([a, b])).toBe(clean);
      }
  });
});

describe("saveProgress", () => {
  const recorder = () => {
    const calls: unknown[][] = [];
    const db = { execute: async (...args: unknown[]) => (calls.push(args), 1) } as unknown as Db;
    return { db, calls };
  };

  it("stores the value as JSON text", async () => {
    const { db, calls } = recorder();
    await saveProgress(db, "guest:1", "settings", { grade: 5 }, 42);
    expect(calls[0][1]).toEqual(["guest:1", "settings", '{"grade":5}', 42]);
  });

  it.each([[undefined], [null], [() => 1]])("refuses an empty value %s", async (value) => {
    const { db, calls } = recorder();
    await expect(saveProgress(db, "guest:1", "attempt:x", value, 1)).rejects.toThrow(
      /empty progress value for attempt:x/,
    );
    expect(calls).toEqual([]);
  });
});

describe("mergeUserProgress", () => {
  it("moves guest rows, never writes an empty value and removes the guest", async () => {
    const rows: Record<string, { key: string; data: string; updated: number }[]> = {
      "guest:g": [
        { key: "settings", data: '{"grade":5}', updated: 10 },
        // A row that holds JSON null (cannot be written by the server, but must not break sign-in).
        { key: "code:t", data: "null", updated: 10 },
      ],
      "max:m": [],
    };
    const writes: unknown[][] = [];
    const db = {
      query: async (_sql: string, params: string[]) => rows[params[0]] ?? [],
      execute: async (sql: string, params: unknown[]) => (writes.push([sql, params]), 1),
      transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
    };
    expect(await mergeUserProgress(db as unknown as Db, "guest:g", "max:m", 99)).toBe(2);
    const upserts = writes.filter(([sql]) => String(sql).startsWith("INSERT INTO progress"));
    expect(upserts.map(([, params]) => params)).toEqual([["max:m", "settings", '{"grade":5}', 99]]);
    expect(writes.filter(([sql]) => String(sql).startsWith("DELETE"))).toHaveLength(2);
  });
});
