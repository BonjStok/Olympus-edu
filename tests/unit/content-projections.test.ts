import { describe, expect, it } from "vitest";
import type { ContentRecord, Lesson, Olympiad, Task } from "@/lib/domain/types";
import { ApiError } from "@/lib/server/errors";
import {
  isVisibleTo,
  notFoundError,
  publicSummary,
  publicTask,
  reviewedTask,
} from "@/lib/services/content";

const task: Task = {
  id: "t1",
  kind: "tasks",
  title: "Задание",
  grade: 4,
  subject: "info",
  topicId: "info-4-01",
  order: 2,
  type: "code",
  prompt: "Сложи два числа",
  answer: "–",
  solution: "a + b",
  hint: "Используй input()",
  points: 2,
  tests: [{ input: "1 2", output: "3" }],
  example: { input: "2 2", output: "4" },
};

const lesson: Lesson = {
  id: "l1",
  kind: "lessons",
  title: "Урок",
  grade: 4,
  subject: "info",
  topicId: "info-4-01",
  order: 1,
  blocks: [{ type: "text", value: "Длинный текст" }],
};

const olympiad: Olympiad = {
  id: "o1",
  kind: "olympiads",
  title: "Олимпиада",
  subject: "math",
  grades: [4],
  format: "online",
  region: "",
  url: "https://example.ru",
  date: "2026-10-10",
  deadline: "2026-10-01",
};

describe("task projections", () => {
  it("publicTask removes the answer, solution, hint and hidden tests", () => {
    const view = publicTask(task);
    for (const field of ["answer", "solution", "hint", "tests"])
      expect(view).not.toHaveProperty(field);
    expect(view).toMatchObject({
      prompt: "Сложи два числа",
      example: { input: "2 2", output: "4" },
    });
  });

  it("reviewedTask keeps the solution but never the hidden tests", () => {
    const view = reviewedTask(task);
    expect(view).toMatchObject({ answer: "–", solution: "a + b", hint: "Используй input()" });
    expect(view).not.toHaveProperty("tests");
  });

  it("does not mutate the stored task", () => {
    publicTask(task);
    reviewedTask(task);
    expect(task.tests).toHaveLength(1);
  });
});

describe("publicSummary", () => {
  it("keeps only list fields of tasks", () => {
    expect(publicSummary(task)).toEqual({
      id: "t1",
      kind: "tasks",
      title: "Задание",
      grade: 4,
      subject: "info",
      topicId: "info-4-01",
      order: 2,
      type: "code",
      points: 2,
      unpublished: undefined,
    });
  });

  it("keeps only list fields of lessons", () => {
    const summary = publicSummary(lesson);
    expect(summary).not.toHaveProperty("blocks");
    expect(summary).toMatchObject({ id: "l1", topicId: "info-4-01", order: 1 });
  });

  it("passes other kinds through unchanged", () => {
    expect(publicSummary(olympiad)).toBe(olympiad);
  });
});

describe("visibility", () => {
  it("hides unpublished drafts from everyone but admins", () => {
    const draft = { ...olympiad, unpublished: true } as ContentRecord;
    expect(isVisibleTo(olympiad, { admin: false })).toBe(true);
    expect(isVisibleTo(draft, { admin: false })).toBe(false);
    expect(isVisibleTo(draft, { admin: true })).toBe(true);
  });

  it.each([
    ["topics", "TOPIC_NOT_FOUND"],
    ["lessons", "LESSON_NOT_FOUND"],
    ["tasks", "TASK_NOT_FOUND"],
    ["olympiads", "OLYMPIAD_NOT_FOUND"],
    ["mock-tests", "MOCK_NOT_FOUND"],
  ] as const)("not-found error of %s is a 404 %s", (kind, code) => {
    const error = notFoundError(kind);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code });
    expect(error.message).toMatch(/не найден/);
  });
});
