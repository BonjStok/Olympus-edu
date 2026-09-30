/**
 * Quality gates for the educational content in `content/`.
 *
 * These tests protect children from broken material: every reference solution of a
 * programming task must pass its own tests, answers must be well-formed, and tasks and
 * lessons must be real teaching material rather than repeated templates.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Lesson, MockTest, Task, Topic } from "@/lib/domain/types";

const CONTENT = path.resolve(__dirname, "../../../content");

function readKind<T>(kind: string): T[] {
  const dir = path.join(CONTENT, kind);
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => ({ ...record, kind }));
    });
}

// CONTENT_SCOPE=math-4 limits the per-record checks to one subject/grade while editing.
const scope = process.env.CONTENT_SCOPE ?? "";
const inScope = (id: string) => !scope || id.startsWith(`${scope}-`);

const topics = readKind<Topic>("topics").filter((topic) => inScope(topic.id));
const lessons = readKind<Lesson>("lessons").filter((lesson) => inScope(lesson.topicId));
const tasks = readKind<Task>("tasks").filter((task) => inScope(task.topicId));
const mocks = readKind<MockTest>("mock-tests");
const codeTasks = tasks.filter((task) => task.type === "code");
const numberTasks = tasks.filter((task) => task.type === "number");

const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** Same normalisation as the runner: CRLF -> LF, trailing spaces per line, trailing newlines. */
function normalizeOutput(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd();
}

function runPython(code: string, input: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", code], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, code: exitCode });
    });
    child.stdin.end(input);
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

describe("content structure", () => {
  it("has unique ids across all content", () => {
    const ids = [...topics, ...lessons, ...tasks, ...mocks].map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(topics.map((topic) => [topic.id, topic] as const))(
    "topic %s has at least 5 lessons and 5 tasks with unique order",
    (id) => {
      for (const items of [
        lessons.filter((lesson) => lesson.topicId === id),
        tasks.filter((task) => task.topicId === id),
      ]) {
        expect(items.length).toBeGreaterThanOrEqual(5);
        const orders = items.map((item) => item.order);
        expect(new Set(orders).size).toBe(orders.length);
      }
    },
  );

  it("gives every topic its own description", () => {
    const descriptions = topics.map((topic) => (topic.description ?? "").trim());
    expect(descriptions.every((text) => text.length >= 20)).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe("lessons", () => {
  it.each(lessons.map((lesson) => [lesson.id, lesson] as const))(
    "%s is a real lesson (at least 200 characters of text)",
    (_id, lesson) => {
      const text = lesson.blocks.map((block) => `${block.value} ${block.caption ?? ""}`).join(" ");
      expect(text.replace(/\s+/g, " ").trim().length).toBeGreaterThanOrEqual(200);
    },
  );

  it.each(topics.map((topic) => [topic.id] as const))(
    "topic %s explains at least one worked example",
    (id) => {
      const blocks = lessons
        .filter((lesson) => lesson.topicId === id)
        .flatMap((lesson) => lesson.blocks);
      expect(blocks.some((block) => block.type === "example" || block.type === "code")).toBe(true);
    },
  );
});

describe("tasks", () => {
  it.each(topics.map((topic) => [topic.id] as const))(
    "topic %s has no repeated task templates",
    (id) => {
      const templates = tasks
        .filter((task) => task.topicId === id)
        .map((task) => task.prompt.replace(/\d+/g, "N").replace(/\s+/g, " ").trim());
      expect(new Set(templates).size).toBe(templates.length);
    },
  );

  it.each(numberTasks.map((task) => [task.id, task] as const))(
    "%s has a numeric answer and an explained solution",
    (_id, task) => {
      expect(String(task.answer)).toMatch(/^[-+]?\d+(?:[.,]\d+)?$/);
      expect(task.solution.trim().length).toBeGreaterThanOrEqual(40);
    },
  );

  it.each(codeTasks.map((task) => [task.id, task] as const))(
    "%s has sane tests and a public example equal to the first test",
    (_id, task) => {
      expect(task.tests?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(task.tests?.length ?? 0).toBeLessThanOrEqual(20);
      expect(task.example).toEqual(task.tests?.[0]);
      expect(task.solution).not.toMatch(/Адаптируй|TODO|FIXME/i);
    },
  );

  it.skipIf(!hasPython)(
    "every reference solution of a programming task passes all of its tests",
    async () => {
      const cases = codeTasks.flatMap((task) =>
        (task.tests ?? []).map((test, index) => ({ task, test, index })),
      );
      const failures = (
        await mapLimit(cases, 8, async ({ task, test, index }) => {
          const result = await runPython(task.solution, test.input);
          const ok =
            result.code === 0 && normalizeOutput(result.stdout) === normalizeOutput(test.output);
          return ok ? null : `${task.id} test #${index + 1}`;
        })
      ).filter(Boolean);
      expect(failures).toEqual([]);
    },
    120_000,
  );
});

describe("Russian text", () => {
  // Numerals 2–4 (but not 12–14) need the genitive singular: «3 минуты», «2 раза», «4 значка».
  // `\b` is ASCII-only in JS, so word boundaries are spelled out with Unicode classes.
  const FEW =
    /(?<!(?:^|[^\p{L}])(?:из|до|от|без|около|более|менее|больше|меньше|свыше)\s)(?<![\p{L}\d])(\d*[234])\s(минут|значков|раз|задач|учеников|школьников|карандашей|рублей|книг|страниц|часов|дней|метров|шагов|яблок|конфет)(?![\p{L}])/giu;

  it("uses correct noun forms after numerals 2–4", () => {
    const problems: string[] = [];
    for (const record of [...tasks, ...lessons]) {
      const text =
        "prompt" in record
          ? `${record.prompt} ${record.solution} ${record.hint ?? ""}`
          : record.blocks.map((block) => block.value).join(" ");
      for (const match of text.matchAll(FEW)) {
        const number = Number(match[1]);
        if (number % 100 >= 12 && number % 100 <= 14) continue;
        problems.push(`${record.id}: «${match[0]}»`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("evaluator fixtures", () => {
  const data = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../test-data.json"), "utf8"),
  ) as {
    topicId: string;
    lessonId: string;
    numericTask: { id: string; correctAnswer: string };
    mockId: string;
    mockAnswers: Record<string, string>;
  };

  it("point at existing records with the current correct answers", () => {
    expect(topics.some((topic) => topic.id === data.topicId)).toBe(true);
    expect(lessons.some((lesson) => lesson.id === data.lessonId)).toBe(true);
    const task = tasks.find((item) => item.id === data.numericTask.id);
    expect(task?.answer).toBe(data.numericTask.correctAnswer);
    const mock = mocks.find((item) => item.id === data.mockId);
    expect(mock).toBeDefined();
    for (const [taskId, answer] of Object.entries(data.mockAnswers)) {
      expect(mock?.taskIds).toContain(taskId);
      expect(tasks.find((item) => item.id === taskId)?.answer).toBe(answer);
    }
  });
});
