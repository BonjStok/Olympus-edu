// The evaluator contract: DATA-API.yaml must point at records that exist in the compiled content
// (lib/seed.json) with the answers the content has today, agree with test-data.json (used by
// scripts/api-smoke.mjs) and cover the /api/v1 operations of openapi.yaml.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContentRecord, MockTest, RecordKind, Task } from "@/lib/domain/types";
import {
  openapiServers,
  parseYamlSubset,
  placeholders,
  readDataApi,
  type DataApiCheck,
} from "../../support/data-api";
import { documentedStatuses } from "../../support/openapi";

const PRODUCTION_URL = "https://olympus-edu.ru";
/** Variables the evaluator takes from its own configuration, not from earlier checks. */
const ENVIRONMENT = new Set(["TEST_API_USERNAME", "TEST_API_PASSWORD"]);
/** Path template → kind of the record named by `{id}`. */
const KIND_BY_PATH: Record<string, RecordKind> = {
  "/api/v1/topics/{id}": "topics",
  "/api/v1/lessons/{id}/view": "lessons",
  "/api/v1/tasks/{id}/check": "tasks",
  "/api/v1/olympiads/{id}/register": "olympiads",
  "/api/v1/mocks/{id}/start": "mock-tests",
};

const api = readDataApi();
const checks = api.checks;
const all = [...checks, ...(api.cleanup ?? [])];
const byId = new Map(checks.map((check) => [check.id, check]));
const content = JSON.parse(fs.readFileSync("lib/seed.json", "utf8")) as ContentRecord[];
const records = new Map(content.map((record) => [record.id, record]));
const testData = JSON.parse(fs.readFileSync("test-data.json", "utf8")) as {
  role: string;
  topicId: string;
  lessonId: string;
  numericTask: { id: string; correctAnswer: string };
  olympiadId: string;
  mockId: string;
  mockAnswers: Record<string, string>;
};

const operation = (check: DataApiCheck) => `${check.method} ${check.path}`;
const pathId = (check: DataApiCheck) => check.request?.path?.id;
const answersOf = (check: DataApiCheck) =>
  (check.request?.body?.answers ?? {}) as Record<string, string>;

function only(predicate: (check: DataApiCheck) => boolean): DataApiCheck {
  const found = checks.filter(predicate);
  expect(found, "exactly one matching check").toHaveLength(1);
  return found[0];
}

/** Every check `check` depends on, directly or through other checks. */
function dependencies(check: DataApiCheck, seen = new Set<string>()): Set<string> {
  for (const id of check.dependsOn ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const next = byId.get(id);
    if (next) dependencies(next, seen);
  }
  return seen;
}

describe("the YAML subset reader", () => {
  it("reads mappings, `- key:` items, quoted and flow scalars", () => {
    const parsed = parseYamlSubset(
      [
        "# comment",
        "a: 1",
        "b:",
        '  - id: "x"',
        "    list: [200, 201]",
        '    map: {type: "string", n: 2}',
        "    nested:",
        '      math-4-01-task-2: "25"',
        "  - plain",
        "c: 'it''s'",
        "d: true",
        "e: https://olympus-edu.ru",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      a: 1,
      b: [
        {
          id: "x",
          list: [200, 201],
          map: { type: "string", n: 2 },
          nested: { "math-4-01-task-2": "25" },
        },
        "plain",
      ],
      c: "it's",
      d: true,
      e: "https://olympus-edu.ru",
    });
  });

  it("reports what it does not understand with the line number", () => {
    expect(() => parseYamlSubset("a: 1\n  b: 2")).toThrow(/line 2/);
    expect(() => parseYamlSubset("a: >\n  text")).toThrow(/line 1: block scalars/);
    expect(() => parseYamlSubset("a: [1, 2")).toThrow(/line 1/);
    expect(() => parseYamlSubset("a: 1\na: 2")).toThrow(/duplicate key a/);
  });
});

describe("DATA-API.yaml", () => {
  it("targets the production host that openapi.yaml declares", () => {
    expect(api.schemaVersion).toBe("1.0");
    expect(api.solution.name).toBe("Олимпус");
    expect(typeof api.solution.teamId).toBe("string");
    expect(api.solution.teamId.trim()).not.toBe("");
    expect(api.api.baseUrl).toBe(PRODUCTION_URL);
    expect(api.api.openapi).toBe("./openapi.yaml");
    expect(openapiServers()).toContain(api.api.baseUrl);
    expect(api.api.defaultHeaders).toEqual({ Accept: "application/json" });
  });

  it("has unique check ids and dependencies on earlier checks only", () => {
    const ids = all.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    checks.forEach((check, index) => {
      const earlier = new Set(checks.slice(0, index).map((item) => item.id));
      for (const id of check.dependsOn ?? [])
        expect(earlier.has(id), `${check.id} → ${id}`).toBe(true);
    });
  });

  it("uses only variables that the environment or an earlier check provides", () => {
    const extracted = new Map<string, string>();
    for (const check of all) {
      const deps = dependencies(check);
      for (const name of placeholders(check.request)) {
        if (ENVIRONMENT.has(name)) continue;
        const source = extracted.get(name);
        expect(source, `${check.id} uses \${${name}} before it is extracted`).toBeDefined();
        // A regular check must depend on the check that extracts its variable.
        if (checks.includes(check))
          expect(deps.has(source!), `${check.id} must depend on ${source}`).toBe(true);
      }
      for (const [name, path] of Object.entries(check.extract ?? {})) {
        expect(path).toMatch(/^\$\.[A-Za-z]+(?:\.[A-Za-z]+)*$/);
        extracted.set(name, check.id);
      }
    }
  });

  it("covers exactly the /api/v1 operations of openapi.yaml with documented statuses", () => {
    const documented = documentedStatuses();
    const v1 = [...documented.keys()].filter((key) => key.includes(" /api/v1/")).sort();
    expect([...new Set(all.map(operation))].sort()).toEqual(v1);
    for (const check of all) {
      const statuses = documented.get(operation(check) as `${Uppercase<string>} ${string}`)!;
      for (const status of check.expected.statusCodes)
        expect(statuses.has(status), `${check.id} expects ${status}`).toBe(true);
      if (check.expected.contentType) expect(check.expected.contentType).toBe("application/json");
    }
  });

  it("names published records of the compiled content with the kind their endpoint expects", () => {
    const named = checks.filter((check) => pathId(check) && !placeholders(pathId(check)).length);
    expect(named.map((check) => check.path).sort()).toEqual(Object.keys(KIND_BY_PATH).sort());
    for (const check of named) {
      const record = records.get(pathId(check)!);
      expect(record, `${check.id}: ${pathId(check)} is not in lib/seed.json`).toBeDefined();
      expect(record!.kind, check.id).toBe(KIND_BY_PATH[check.path]);
      expect(record!.unpublished, `${check.id}: ${record!.id} is a draft`).toBeFalsy();
    }
  });

  it("registers for a published, real olympiad", () => {
    const check = only((item) => item.path === "/api/v1/olympiads/{id}/register");
    const olympiad = records.get(pathId(check)!);
    expect(olympiad).toMatchObject({ kind: "olympiads" });
    expect(olympiad!.unpublished).toBeFalsy();
    expect(olympiad!.demo).toBeFalsy();
    expect(check.request?.body).toEqual({ registered: true });
  });

  it("checks a numeric task with its current correct answer", () => {
    const check = only((item) => item.path === "/api/v1/tasks/{id}/check");
    const task = records.get(pathId(check)!) as Task;
    expect(task.type).toBe("number");
    expect(check.request?.body).toEqual({ answer: task.answer });
  });

  it("answers the fixed mock with the content answers, and every task of it when finishing", () => {
    const start = only((item) => item.path === "/api/v1/mocks/{id}/start");
    const mock = records.get(pathId(start)!) as MockTest;
    expect(mock.randomize, "the scenario needs a mock with a fixed task list").toBeFalsy();
    const save = only((item) => operation(item) === "PATCH /api/v1/mock-attempts/{id}");
    const finish = only((item) => operation(item) === "POST /api/v1/mock-attempts/{id}/finish");
    for (const check of [save, finish]) {
      expect(dependencies(check).has(start.id), `${check.id} depends on ${start.id}`).toBe(true);
      const answers = answersOf(check);
      expect(Object.keys(answers).length).toBeGreaterThan(0);
      for (const [taskId, answer] of Object.entries(answers)) {
        expect(mock.taskIds, `${check.id}: ${taskId} is not a task of ${mock.id}`).toContain(
          taskId,
        );
        expect(answer, `${check.id}: answer of ${taskId}`).toBe(
          (records.get(taskId) as Task).answer,
        );
      }
    }
    // All answers correct on finish → the full score of the mock.
    expect(Object.keys(answersOf(finish)).sort()).toEqual([...mock.taskIds].sort());
    for (const taskId of mock.taskIds)
      expect((records.get(taskId) as Task).type, `${taskId} is graded automatically`).toBe(
        "number",
      );
  });

  it("agrees with test-data.json used by scripts/api-smoke.mjs", () => {
    const path = (template: string) => pathId(only((item) => item.path === template));
    expect(testData.role).toBe("test_user");
    expect(path("/api/v1/topics/{id}")).toBe(testData.topicId);
    expect(path("/api/v1/lessons/{id}/view")).toBe(testData.lessonId);
    expect(path("/api/v1/tasks/{id}/check")).toBe(testData.numericTask.id);
    expect(only((item) => item.path === "/api/v1/tasks/{id}/check").request?.body?.answer).toBe(
      testData.numericTask.correctAnswer,
    );
    expect(path("/api/v1/olympiads/{id}/register")).toBe(testData.olympiadId);
    expect(path("/api/v1/mocks/{id}/start")).toBe(testData.mockId);
    const finish = only((item) => operation(item) === "POST /api/v1/mock-attempts/{id}/finish");
    expect(answersOf(finish)).toEqual(testData.mockAnswers);
    const save = only((item) => operation(item) === "PATCH /api/v1/mock-attempts/{id}");
    for (const [taskId, answer] of Object.entries(answersOf(save)))
      expect(testData.mockAnswers[taskId]).toBe(answer);
  });

  it("uses the test_user role everywhere except the public health check", () => {
    for (const check of all)
      expect(check.role, check.id).toBe(check.path === "/api/v1/health" ? "public" : "test_user");
  });
});
