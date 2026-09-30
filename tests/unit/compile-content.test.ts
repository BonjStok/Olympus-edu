import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileContent } from "../../scripts/compile-content.mjs";

type Json = Record<string, unknown>;
const dirs: string[] = [];

/** Creates a temporary content directory from `{ "kind/file.json": records }`. */
function contentDir(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olympus-content-"));
  dirs.push(dir);
  for (const [file, data] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data));
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const topic = { id: "math-4-01", title: "Тема", grade: 4, subject: "math", order: 1 };
const taskRecord = {
  id: "t1",
  title: "Задание",
  topicId: "math-4-01",
  type: "number",
  prompt: "?",
  answer: "1",
  solution: "!",
};
const olympiad = (id: string, extra: Json = {}) => ({
  id,
  title: "Математический старт",
  subject: "math",
  grades: [4],
  format: "online",
  region: "",
  deadline: "2026-10-01",
  date: "2026-10-10",
  url: "",
  ...extra,
});

describe("compileContent", () => {
  it("validates a bundle, assigns kinds and inherits grade/subject from topics", () => {
    const dir = contentDir({
      "topics/initial.json": [topic],
      "tasks/initial.json": [taskRecord],
      "mock-tests/initial.json": {
        id: "m1",
        title: "Пробник",
        grade: 4,
        subject: "math",
        minutes: 10,
        taskIds: ["t1"],
      },
      "olympiads/imports/extra.json": [
        olympiad("o1", { date: "ожидается", deadline: "ожидается" }),
      ],
    });
    const records = compileContent({ contentDir: dir });
    expect(records.map((record) => `${record.kind}:${record.id}`)).toEqual([
      "olympiads:o1",
      "topics:math-4-01",
      "tasks:t1",
      "mock-tests:m1",
    ]);
    expect(records[2]).toMatchObject({ grade: 4, subject: "math" });
    expect(records[0]).toMatchObject({ date: "expected", deadline: "expected" });
  });

  it("reads top-level files before imports/ so imports can override nothing silently", () => {
    const dir = contentDir({
      "topics/imports/b.json": [{ ...topic, id: "b", order: 2 }],
      "topics/a.json": [{ ...topic, id: "a" }],
    });
    expect(compileContent({ contentDir: dir }).map((record) => record.id)).toEqual(["a", "b"]);
  });

  it("reports JSON syntax errors with the file path", () => {
    const dir = contentDir({ "topics/broken.json": "[{" });
    expect(() => compileContent({ contentDir: dir })).toThrow(
      /topics[/\\]broken\.json: ошибка JSON/,
    );
  });

  it("reports validation errors with the file path", () => {
    const dir = contentDir({ "topics/bad.json": [{ ...topic, grade: 9 }] });
    expect(() => compileContent({ contentDir: dir })).toThrow(/bad\.json: math-4-01: grade/);
  });

  it("rejects a repeated id inside one file", () => {
    const dir = contentDir({ "topics/initial.json": [topic, topic] });
    expect(() => compileContent({ contentDir: dir })).toThrow(/повтор ID math-4-01/);
  });

  it("rejects the same id in two sections", () => {
    const dir = contentDir({
      "topics/initial.json": [topic],
      "tasks/initial.json": [{ ...taskRecord, id: "math-4-01" }],
    });
    expect(() => compileContent({ contentDir: dir })).toThrow(/уже используется в разделе topics/);
  });

  it("rejects duplicate olympiads across files and names both records", () => {
    const dir = contentDir({
      "olympiads/initial.json": [olympiad("first")],
      "olympiads/imports/more.json": [olympiad("second", { title: "«математический СТАРТ»" })],
    });
    expect(() => compileContent({ contentDir: dir })).toThrow(/second повторяет first/);
  });

  it("reports link errors with the source file of the record", () => {
    const dir = contentDir({ "tasks/orphans.json": [{ ...taskRecord, topicId: "missing" }] });
    expect(() => compileContent({ contentDir: dir })).toThrow(
      /tasks[/\\]orphans\.json: t1: тема missing не найдена/,
    );
  });

  it("validates regions against the provided list", () => {
    const dir = contentDir({
      "olympiads/initial.json": [olympiad("o1", { region: "Тестовый край" })],
    });
    expect(() => compileContent({ contentDir: dir })).toThrow(/не найден в справочнике/);
    expect(compileContent({ contentDir: dir, regions: ["Тестовый край"] })).toHaveLength(1);
  });

  it("compiles the repository content into exactly lib/seed.json", () => {
    const seed = JSON.parse(fs.readFileSync("lib/seed.json", "utf8"));
    expect(compileContent()).toEqual(seed);
  });
});
