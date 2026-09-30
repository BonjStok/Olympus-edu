import { describe, expect, it, vi } from "vitest";
import type { MockAttempt, MockResult, MockTest, Task } from "@/lib/domain/types";
import { ApiError } from "@/lib/server/errors";
import {
  DEFAULT_RANDOM_TASK_COUNT,
  gradeAttempt,
  isAcceptingAnswers,
  MOCK_SUBMIT_GRACE_MS,
  pickTaskIds,
  presentAttempt,
  resultStatus,
  SELF_CHECK_NOTE,
  totals,
  UNCHECKED_NOTE,
  type CodeGrader,
} from "@/lib/services/mocks";

const mockTest = (extra: Partial<MockTest> = {}): MockTest => ({
  id: "m1",
  kind: "mock-tests",
  title: "Пробник",
  grade: 4,
  subject: "math",
  olympiad: "Тур",
  minutes: 40,
  taskIds: Array.from({ length: 20 }, (_, i) => `t${i + 1}`),
  ...extra,
});

const makeTask = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  kind: "tasks",
  title: id,
  grade: 4,
  subject: "math",
  topicId: "topic",
  order: 1,
  type: "number",
  prompt: "?",
  answer: "3",
  solution: "!",
  ...extra,
});

const attemptOf = (
  tasks: Task[],
  answers: MockAttempt["answers"] = {},
  extra: Partial<MockAttempt<Task>> = {},
): MockAttempt<Task> => ({
  id: "a1",
  testId: "m1",
  title: "Пробник",
  subject: "math",
  started: 0,
  ends: 60_000,
  tasks,
  answers,
  finished: false,
  ...extra,
});

/** Deterministic pseudo-random generator for shuffles. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe("pickTaskIds", () => {
  it("keeps all tasks in order for a fixed mock", () => {
    const test = mockTest({ taskIds: ["a", "b", "c"] });
    expect(pickTaskIds(test, () => 0)).toEqual(["a", "b", "c"]);
  });

  it("draws taskCount distinct tasks from a randomised mock, reproducibly for a seed", () => {
    const test = mockTest({ randomize: true, taskCount: 5 });
    const first = pickTaskIds(test, seeded(7));
    expect(first).toHaveLength(5);
    expect(new Set(first).size).toBe(5);
    expect(first.every((id) => test.taskIds.includes(id))).toBe(true);
    expect(pickTaskIds(test, seeded(7))).toEqual(first);
    expect(pickTaskIds(test, seeded(8))).not.toEqual(first);
  });

  it("defaults to 10 tasks and never draws fewer than one", () => {
    expect(DEFAULT_RANDOM_TASK_COUNT).toBe(10);
    expect(pickTaskIds(mockTest({ randomize: true }), seeded(1))).toHaveLength(10);
    expect(pickTaskIds(mockTest({ randomize: true, taskCount: -3 }), seeded(1))).toHaveLength(1);
  });

  it("does not modify the mock record", () => {
    const test = mockTest({ randomize: true, taskCount: 3 });
    const before = [...test.taskIds];
    pickTaskIds(test, seeded(3));
    expect(test.taskIds).toEqual(before);
  });
});

describe("isAcceptingAnswers", () => {
  const attempt = attemptOf([], {}, { ends: 10_000 });

  it.each([
    [9_000, true],
    [10_000, true],
    [10_000 + MOCK_SUBMIT_GRACE_MS, true],
    [10_001 + MOCK_SUBMIT_GRACE_MS, false],
  ])("at %i ms → %s", (now, expected) => {
    expect(isAcceptingAnswers(attempt, now)).toBe(expected);
  });

  it("never accepts answers for a finished attempt", () => {
    expect(isAcceptingAnswers({ ...attempt, finished: true }, 0)).toBe(false);
  });
});

describe("gradeAttempt", () => {
  const passAll: CodeGrader = async () => true;

  it("grades number answers, including decimal commas; objects are wrong", async () => {
    const tasks = [
      makeTask("n1", { answer: "1.5", points: 2 }),
      makeTask("n2"),
      makeTask("n3"),
      makeTask("n4"),
    ];
    const graded = await gradeAttempt(
      attemptOf(tasks, { n1: "1,5", n2: "4", n3: { code: "3", language: "python" } }),
      passAll,
    );
    expect(graded.results.map((r) => [r.id, r.status, r.points, r.max])).toEqual([
      ["n1", "correct", 2, 2],
      ["n2", "wrong", 0, 1],
      ["n3", "wrong", 0, 1],
      ["n4", "wrong", 0, 1],
    ]);
    expect(graded).toMatchObject({ score: 2, max: 5, pending: 0 });
  });

  it("leaves proofs for the child's self-check", async () => {
    const graded = await gradeAttempt(
      attemptOf([makeTask("p1", { type: "proof", answer: undefined })], { p1: "Доказательство" }),
      passAll,
    );
    expect(graded.results[0]).toEqual({
      id: "p1",
      correct: false,
      points: 0,
      max: 1,
      note: SELF_CHECK_NOTE,
      status: "self-check",
    });
    expect(graded.pending).toBe(0);
  });

  it("sends code answers to the grader with the answer's language", async () => {
    const grader = vi.fn<CodeGrader>(async (_task, answer) => answer.code.includes("ok"));
    const tasks = [makeTask("c1", { type: "code" }), makeTask("c2", { type: "code" })];
    const graded = await gradeAttempt(
      attemptOf(tasks, {
        c1: { code: "print('ok')", language: "python" },
        c2: { code: "bad", language: "cpp" },
      }),
      grader,
    );
    expect(grader).toHaveBeenCalledTimes(2);
    expect(grader.mock.calls[1][1]).toEqual({ code: "bad", language: "cpp" });
    expect(graded.results.map((r) => r.status)).toEqual(["correct", "wrong"]);
  });

  it("marks missing, text and blank code answers wrong without calling the grader", async () => {
    const grader = vi.fn<CodeGrader>(async () => true);
    const tasks = ["c1", "c2", "c3"].map((id) => makeTask(id, { type: "code" }));
    const graded = await gradeAttempt(
      attemptOf(tasks, { c2: "print(1)", c3: { code: "   \n", language: "python" } }),
      grader,
    );
    expect(grader).not.toHaveBeenCalled();
    expect(graded.results.map((r) => r.status)).toEqual(["wrong", "wrong", "wrong"]);
  });

  it("keeps code unchecked (no points) when the runner is down or busy", async () => {
    const tasks = ["c1", "c2", "c3"].map((id) => makeTask(id, { type: "code", points: 3 }));
    const failures = [
      new ApiError(503, "RUNNER_UNAVAILABLE", "down"),
      new ApiError(429, "RUNNER_BUSY", "busy"),
      new TypeError("socket hang up"),
    ];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const graded = await gradeAttempt(
      attemptOf(
        tasks,
        Object.fromEntries(tasks.map((t) => [t.id, { code: "x", language: "python" as const }])),
      ),
      async (task) => {
        throw failures[Number(task.id.slice(1)) - 1];
      },
    );
    expect(graded.results.every((r) => r.status === "unchecked" && r.note === UNCHECKED_NOTE)).toBe(
      true,
    );
    expect(graded).toMatchObject({ score: 0, max: 9, pending: 3 });
    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it("marks code wrong with the explanation when the runner rejects it", async () => {
    const graded = await gradeAttempt(
      attemptOf([makeTask("c1", { type: "code" })], { c1: { code: "x", language: "python" } }),
      async () => {
        throw new ApiError(422, "INVALID_CODE", "Программа слишком большая");
      },
    );
    expect(graded.results[0]).toMatchObject({ status: "wrong", note: "Программа слишком большая" });
    expect(graded.pending).toBe(0);
  });

  it("treats a stored code answer without a code string as wrong", async () => {
    const graded = await gradeAttempt(
      attemptOf([makeTask("c1", { type: "code" })], {
        c1: { language: "python" } as unknown as MockAttempt["answers"][string],
      }),
      passAll,
    );
    expect(graded.results[0].status).toBe("wrong");
  });

  // Attempts stored by the previous server version could contain unvalidated answers.
  it("treats a legacy code answer whose code is not a string as wrong", async () => {
    const graded = await gradeAttempt(
      attemptOf([makeTask("c1", { type: "code" })], {
        c1: { code: null, language: "python" } as unknown as MockAttempt["answers"][string],
      }),
      passAll,
    );
    expect(graded.results[0].status).toBe("wrong");
  });
});

describe("totals and statuses", () => {
  const item = (extra: Partial<MockResult>): MockResult => ({
    id: "x",
    correct: false,
    points: 0,
    max: 2,
    note: "",
    ...extra,
  });

  it("scores only correct results and counts unchecked ones as pending", () => {
    expect(
      totals([
        item({ correct: true, points: 2, status: "correct" }),
        item({ status: "unchecked" }),
        item({ status: "self-check" }),
        item({ correct: false, points: 2, status: "wrong" }),
      ]),
    ).toEqual({ score: 2, max: 8, pending: 1 });
  });

  it("derives statuses of legacy results", () => {
    const proof = makeTask("p", { type: "proof" });
    expect(resultStatus(item({ status: "unchecked" }), undefined)).toBe("unchecked");
    expect(resultStatus(item({ correct: true }), undefined)).toBe("correct");
    expect(resultStatus(item({ note: SELF_CHECK_NOTE }), proof)).toBe("self-check");
    expect(resultStatus(item({ note: "Самопроверка" }), proof)).toBe("wrong");
    expect(resultStatus(item({ note: SELF_CHECK_NOTE }), makeTask("n"))).toBe("wrong");
  });
});

describe("presentAttempt", () => {
  const code = makeTask("c1", { type: "code", tests: [{ input: "1", output: "1" }], hint: "h" });
  const proof = makeTask("p1", { type: "proof" });

  it("sanitises a running attempt", () => {
    const presented = presentAttempt(attemptOf([code]));
    expect(presented.tasks[0]).not.toHaveProperty("answer");
    expect(presented.tasks[0]).not.toHaveProperty("tests");
    expect(presented).not.toHaveProperty("pending");
  });

  it("upgrades a legacy finished attempt with statuses and pending", () => {
    const presented = presentAttempt(
      attemptOf(
        [code, proof],
        {},
        {
          finished: true,
          results: [
            { id: "c1", correct: true, points: 1, max: 1, note: "" },
            { id: "p1", correct: false, points: 0, max: 1, note: SELF_CHECK_NOTE },
          ],
          score: 1,
          max: 2,
        },
      ),
    );
    expect(presented.results?.map((r) => r.status)).toEqual(["correct", "self-check"]);
    expect(presented.pending).toBe(0);
    expect(presented.tasks[0]).toMatchObject({ answer: "3", solution: "!" });
    expect(presented.tasks[0]).not.toHaveProperty("tests");
  });

  it("counts pending unchecked results of a finished attempt", () => {
    const presented = presentAttempt(
      attemptOf(
        [code],
        {},
        {
          finished: true,
          results: [
            {
              id: "c1",
              correct: false,
              points: 0,
              max: 1,
              note: UNCHECKED_NOTE,
              status: "unchecked",
            },
          ],
        },
      ),
    );
    expect(presented.pending).toBe(1);
  });
});
