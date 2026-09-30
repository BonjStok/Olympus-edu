// Mock tests through /api/olympus: start, autosave, finish and grading, code answers and the
// runner, proof self-checks. Uses the synthetic course of tests/support/fixtures.ts; the last
// block starts every mock of the real bundle (lib/seed.json).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import type {
  BootstrapResponse,
  ContentRecord,
  MockAttempt,
  MockResult,
  MockTest,
  Task,
} from "@/lib/domain/types";
import { readSeedBundle } from "../../scripts/seed.mjs";
import { correctAnswers, FX, fixtureTask, pointsOf } from "../support/fixtures";
import {
  BY_TOKEN,
  bootstrap,
  configureEnv,
  guestToken,
  resetDatabase,
  rpc,
  signInitData,
  sql,
  startFakeRunner,
  type FakeRunner,
} from "../support/server";

type Attempt = MockAttempt<Partial<Task>>;

const MATH = FX.mocks.math;
const [n1, n2, n3] = FX.numbers;

let runner: FakeRunner;
let runnerUp = true;

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  runner = await startFakeRunner((body) =>
    runnerUp
      ? { body: { correct: body.code === FX.goodProgram, output: "", passed: 1, total: 1 } }
      : { status: 503, body: { error: { message: "Judge0 недоступен" } } },
  );
});
afterAll(() => runner.close());
beforeEach(() => {
  runnerUp = true;
  configureEnv({ RUNNER_URL: runner.url });
});

async function start(token: string, id = MATH.id): Promise<Attempt> {
  const response = await rpc<{ attempt: Attempt }>(POST, "start-mock", { id }, { token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.attempt;
}

async function finish(token: string, id: string, answers?: unknown): Promise<Attempt> {
  const response = await rpc<{ attempt: Attempt }>(
    POST,
    "finish-mock",
    answers === undefined ? { id } : { id, answers },
    { token },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.attempt.finished).toBe(true);
  return response.body.attempt;
}

async function expire(attemptId: string): Promise<void> {
  await sql(
    `UPDATE progress SET data = jsonb_set(data::jsonb, '{ends}', to_jsonb($2::bigint))::text
      WHERE key = $1`,
    [`attempt:${attemptId}`, Date.now() - 60_000],
  );
}

async function storedAttempt(attemptId: string): Promise<MockAttempt<Task>> {
  const [row] = await sql<{ data: string }>("SELECT data FROM progress WHERE key = $1", [
    `attempt:${attemptId}`,
  ]);
  return JSON.parse(row.data) as MockAttempt<Task>;
}

describe("starting a mock", () => {
  it("returns public tasks only and stores the full attempt server-side", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    expect(attempt).toMatchObject({ testId: MATH.id, finished: false, answers: {} });
    expect(attempt.tasks.map((task) => task.id)).toEqual(MATH.taskIds);
    for (const task of attempt.tasks) {
      expect(task).not.toHaveProperty("answer");
      expect(task).not.toHaveProperty("solution");
      expect(task).not.toHaveProperty("hint");
      expect(task).not.toHaveProperty("tests");
    }
    expect(attempt.ends - attempt.started).toBe(MATH.minutes * 60_000);
    const stored = (await bootstrap<BootstrapResponse>(GET, { token })).body.progress[
      `attempt:${attempt.id}`
    ] as Attempt;
    expect(stored.tasks[0]).not.toHaveProperty("answer");
    // The server keeps the reference answers to grade the attempt later.
    expect((await storedAttempt(attempt.id)).tasks[0].answer).toBe(n1.answer);
  });

  it("draws taskCount random tasks for randomised mocks", async () => {
    const random = FX.mocks.random;
    const token = await guestToken(POST);
    const attempt = await start(token, random.id);
    const ids = attempt.tasks.map((task) => task.id as string);
    expect(ids).toHaveLength(random.taskCount!);
    expect(new Set(ids).size).toBe(random.taskCount);
    for (const id of ids) expect(random.taskIds).toContain(id);
    expect(attempt.ends - attempt.started).toBe(random.minutes * 60_000);
  });

  it("returns 404 for unknown mocks", async () => {
    const token = await guestToken(POST);
    const response = await rpc(POST, "start-mock", { id: "no-such-mock" }, { token });
    expect(response).toMatchObject({ status: 404, body: { code: "MOCK_NOT_FOUND" } });
  });
});

describe("saving answers", () => {
  it("merges answer patches (resume without losing answers) and deletes with null or empty", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    const [a, b, c, d] = MATH.taskIds;
    expect(
      (
        await rpc(
          POST,
          "mock-save",
          { id: attempt.id, answers: { [a]: "111", [b]: "222" } },
          { token },
        )
      ).body,
    ).toEqual({ ok: true });
    // A client that lost its local state sends only the new answer.
    await rpc(POST, "mock-save", { id: attempt.id, answers: { [c]: "333" } }, { token });
    await rpc(POST, "mock-save", { id: attempt.id, answers: { [b]: null, [a]: "" } }, { token });
    await rpc(POST, "mock-save", { id: attempt.id, answers: { [d]: "9" } }, { token });
    const current = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-get",
      { id: attempt.id },
      { token },
    );
    expect(current.body.attempt.answers).toEqual({ [c]: "333", [d]: "9" });
    expect(current.body.attempt.tasks[0]).not.toHaveProperty("answer");
  });

  it.each([
    [{ "not-in-attempt": "1" }],
    [{ [MATH.taskIds[0]]: "x".repeat(2001) }],
    [{ [MATH.taskIds[0]]: 5 }],
    [{ [MATH.taskIds[0]]: { code: "x", language: "cobol" } }],
    [["3"]],
    ["3"],
  ])("rejects invalid answers %j", async (answers) => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    const response = await rpc(POST, "mock-save", { id: attempt.id, answers }, { token });
    expect(response).toMatchObject({ status: 422, body: { code: "INVALID_ANSWERS" } });
  });

  it("finishes the attempt when time is over instead of saving", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    const answers = correctAnswers(MATH.taskIds.slice(0, 3));
    await rpc(POST, "mock-save", { id: attempt.id, answers }, { token });
    await expire(attempt.id);
    const response = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-save",
      { id: attempt.id, answers: { [MATH.taskIds[3]]: "9" } },
      { token },
    );
    expect(response.body.attempt.finished).toBe(true);
    expect(response.body.attempt.answers).toEqual(answers);
    expect(response.body.attempt.score).toBe(pointsOf(Object.keys(answers)));
  });

  it("returns the finished attempt when saving after finish", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    await finish(token, attempt.id);
    const response = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-save",
      { id: attempt.id, answers: {} },
      { token },
    );
    expect(response.body.attempt.finished).toBe(true);
  });

  it("does not expose other users' attempts", async () => {
    const attempt = await start(await guestToken(POST));
    const stranger = await guestToken(POST);
    for (const action of ["mock-get", "mock-save", "finish-mock", "mock-recheck", "mock-proof"]) {
      const response = await rpc(
        POST,
        action,
        { id: attempt.id, answers: {}, taskId: FX.proof.id, correct: true },
        { token: stranger },
      );
      expect(response).toMatchObject({ status: 404, body: { code: "ATTEMPT_NOT_FOUND" } });
    }
  });
});

describe("finishing", () => {
  it("grades by task points, reveals solutions but never hidden tests, and is idempotent", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    await rpc(POST, "mock-save", { id: attempt.id, answers: { [n1.id]: n1.answer } }, { token });
    const result = await finish(token, attempt.id, { [n2.id]: "0", [n3.id]: n3.answer });
    expect(result.score).toBe(pointsOf([n1.id, n3.id]));
    expect(result.max).toBe(pointsOf(MATH.taskIds));
    expect(result.pending).toBe(0);
    expect(result.results?.find((item) => item.id === n3.id)).toEqual({
      id: n3.id,
      correct: true,
      points: n3.points,
      max: n3.points,
      note: "",
      status: "correct",
    });
    expect(result.results?.find((item) => item.id === n2.id)).toMatchObject({
      status: "wrong",
      points: 0,
      max: n2.points,
    });
    expect(result.tasks[0]).toMatchObject({ answer: n1.answer, solution: n1.solution });
    for (const task of result.tasks) expect(task).not.toHaveProperty("tests");

    const again = await finish(token, attempt.id, correctAnswers(MATH.taskIds));
    expect(again.finishedAt).toBe(result.finishedAt);
    expect(again.score).toBe(result.score);
  });

  it("gives the full score for all correct answers", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    const result = await finish(token, attempt.id, correctAnswers(MATH.taskIds));
    expect(result.score).toBe(result.max);
    expect(result.results?.every((item) => item.status === "correct")).toBe(true);
  });

  it("ignores late answers after the grace period", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    await expire(attempt.id);
    const finished = await finish(token, attempt.id, correctAnswers(MATH.taskIds));
    expect(finished.answers).toEqual({});
    expect(finished.score).toBe(0);
  });

  it("blocks hint and reveal of tasks in a running attempt", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    for (const action of ["hint", "reveal"]) {
      const response = await rpc(POST, action, { id: n1.id }, { token });
      expect(response).toMatchObject({ status: 409, body: { code: "MOCK_IN_PROGRESS" } });
    }
    // Other tasks and other users are not affected.
    expect(MATH.taskIds).not.toContain(FX.outsideMathMock.id);
    expect((await rpc(POST, "hint", { id: FX.outsideMathMock.id }, { token })).status).toBe(200);
    expect(
      (await rpc(POST, "reveal", { id: n1.id }, { token: await guestToken(POST) })).status,
    ).toBe(200);
    await finish(token, attempt.id);
    expect((await rpc(POST, "reveal", { id: n1.id }, { token })).status).toBe(200);
  });

  it("unblocks hints when the attempt time is over", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    await expire(attempt.id);
    expect((await rpc(POST, "hint", { id: n1.id }, { token })).status).toBe(200);
  });
});

describe("code answers and the runner", () => {
  it("grades tracing tasks at once and keeps code answers unchecked while the runner is down", async () => {
    const info = FX.mocks.info;
    const token = await guestToken(POST);
    const attempt = await start(token, info.id);
    expect(attempt.tasks.map((task) => task.type)).toEqual(
      info.taskIds.map((id) => fixtureTask(id).type),
    );
    const [first, second, third] = attempt.tasks
      .filter((task) => task.type === "code")
      .map((task) => task.id as string);
    runnerUp = false;
    const finished = await finish(token, attempt.id, {
      [FX.trace.id]: FX.trace.answer,
      [first]: { code: FX.goodProgram, language: "python" },
      [second]: { code: "bad", language: "python" },
      [third]: { code: "   ", language: "python" },
    });
    const results = finished.results as MockResult[];
    expect(results.find((item) => item.id === FX.trace.id)).toMatchObject({ status: "correct" });
    expect(results.find((item) => item.id === first)).toMatchObject({
      status: "unchecked",
      points: 0,
    });
    expect(results.find((item) => item.id === third)).toMatchObject({ status: "wrong" });
    expect(finished.pending).toBe(2);
    expect(finished.score).toBe(pointsOf([FX.trace.id]));
    expect(finished.max).toBe(pointsOf(info.taskIds));
    expect(JSON.stringify(finished)).not.toMatch(/Judge0/);

    const stillDown = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-recheck",
      { id: attempt.id },
      { token },
    );
    expect(stillDown.body.attempt.pending).toBe(2);

    runnerUp = true;
    const rechecked = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-recheck",
      { id: attempt.id },
      { token },
    );
    const after = rechecked.body.attempt.results as MockResult[];
    expect(after.find((item) => item.id === first)).toMatchObject({
      status: "correct",
      points: fixtureTask(first).points,
    });
    expect(after.find((item) => item.id === second)).toMatchObject({ status: "wrong" });
    expect(rechecked.body.attempt.pending).toBe(0);
    expect(rechecked.body.attempt.score).toBe(pointsOf([FX.trace.id, first]));
    // Hidden tests stay on the server even after grading.
    for (const task of rechecked.body.attempt.tasks) expect(task).not.toHaveProperty("tests");
    expect(runner.requests.at(-1)!.body.tests).toEqual(fixtureTask(second).tests);
  });

  it("refuses to re-check an unfinished attempt", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    const response = await rpc(POST, "mock-recheck", { id: attempt.id }, { token });
    expect(response).toMatchObject({ status: 409, body: { code: "MOCK_NOT_FINISHED" } });
  });
});

describe("proof self-check in mocks", () => {
  it("scores a proof only after the child's self-check", async () => {
    const mock = FX.mocks.proof;
    const [proofId, numberId] = mock.taskIds;
    const numberTask = fixtureTask(numberId);
    const token = await guestToken(POST);
    const attempt = await start(token, mock.id);
    const early = await rpc(
      POST,
      "mock-proof",
      { id: attempt.id, taskId: proofId, correct: true },
      { token },
    );
    expect(early).toMatchObject({ status: 409, body: { code: "MOCK_NOT_FINISHED" } });

    const finished = await finish(token, attempt.id, {
      [proofId]: "потому что",
      [numberId]: numberTask.answer,
    });
    expect(finished.results?.[0]).toMatchObject({ status: "self-check", points: 0 });
    expect(finished.score).toBe(pointsOf([numberId]));

    const graded = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-proof",
      { id: attempt.id, taskId: proofId, correct: true },
      { token },
    );
    expect(graded.body.attempt.results?.[0]).toMatchObject({
      status: "correct",
      points: FX.proof.points,
      note: "Самопроверка",
    });
    expect(graded.body.attempt.score).toBe(pointsOf(mock.taskIds));
    expect(graded.body.attempt.max).toBe(pointsOf(mock.taskIds));

    const wrongTask = await rpc(
      POST,
      "mock-proof",
      { id: attempt.id, taskId: numberId, correct: true },
      { token },
    );
    expect(wrongTask).toMatchObject({ status: 404, body: { code: "TASK_NOT_FOUND" } });
    const notBoolean = await rpc(
      POST,
      "mock-proof",
      { id: attempt.id, taskId: proofId, correct: 1 },
      { token },
    );
    expect(notBoolean).toMatchObject({ status: 422, body: { code: "INVALID_SELF_CHECK" } });
  });

  it("upgrades legacy finished attempts without statuses on read", async () => {
    const token = await guestToken(POST);
    const attempt = await start(token);
    const finished = await finish(token, attempt.id, correctAnswers(MATH.taskIds));
    expect(finished.results?.length).toBe(MATH.taskIds.length);
    // Downgrade the stored attempt to the format of the first release (no status, no pending).
    await sql(
      `UPDATE progress SET data = (
         SELECT jsonb_set(data::jsonb - 'pending', '{results}',
           (SELECT jsonb_agg(item - 'status') FROM jsonb_array_elements(data::jsonb -> 'results') item))::text
       ) WHERE key = $1`,
      [`attempt:${attempt.id}`],
    );
    const legacy = await storedAttempt(attempt.id);
    expect(legacy).not.toHaveProperty("pending");
    expect(legacy.results?.some((item) => "status" in item)).toBe(false);

    const response = await rpc<{ attempt: Attempt }>(
      POST,
      "mock-get",
      { id: attempt.id },
      { token },
    );
    expect(response.body.attempt.pending).toBe(0);
    expect(response.body.attempt.results?.every((item) => item.status === "correct")).toBe(true);
  });
});

// Regression guard for `null value in column "data" of relation "progress"`: it came from the
// legacy-downgrade SQL above (jsonb_set is STRICT and jsonb_agg over zero rows is NULL) running on
// an attempt that was never finished. These are the server flows that could in principle store an
// empty value; none of them may.
describe("progress data stays a JSON object", () => {
  it("in edge cases of saving, finishing and merging attempts", async () => {
    const guest = await guestToken(POST);
    const keys = () => sql("SELECT user_id, key FROM progress ORDER BY user_id, key");
    const before = await keys();

    // A missing attempt: 404 and nothing is created.
    for (const action of ["mock-save", "finish-mock", "mock-get", "mock-recheck"]) {
      const response = await rpc(
        POST,
        action,
        { id: "00000000-0000-4000-8000-000000000000", answers: {} },
        { token: guest },
      );
      expect(response).toMatchObject({ status: 404, body: { code: "ATTEMPT_NOT_FOUND" } });
    }
    expect(await keys()).toEqual(before);

    // Every answer deleted again, then finished with `answers: null` (no patch).
    const emptied = await start(guest);
    const all = correctAnswers(MATH.taskIds);
    await rpc(POST, "mock-save", { id: emptied.id, answers: all }, { token: guest });
    const clear = Object.fromEntries(MATH.taskIds.map((id, index) => [id, index % 2 ? null : ""]));
    await rpc(POST, "mock-save", { id: emptied.id, answers: clear }, { token: guest });
    expect((await storedAttempt(emptied.id)).answers).toEqual({});
    const result = await finish(guest, emptied.id, null);
    expect(result).toMatchObject({ answers: {}, score: 0 });

    // A running attempt of a guest moves into the MAX account on sign-in and keeps working.
    const running = await start(guest);
    await rpc(
      POST,
      "mock-save",
      { id: running.id, answers: { [n1.id]: n1.answer } },
      { token: guest },
    );
    const initData = await signInitData({ user: { id: 31337, first_name: "Гость" } });
    const signedIn = await rpc<{ sessionToken: string }>(
      POST,
      "session",
      { initData },
      { token: guest },
    );
    const max = signedIn.body.sessionToken;
    expect(await sql(`SELECT 1 FROM sessions WHERE token = ${BY_TOKEN}`, [guest])).toHaveLength(0);
    const moved = await finish(max, running.id, { [n2.id]: n2.answer });
    expect(moved.answers).toEqual({ [n1.id]: n1.answer, [n2.id]: n2.answer });

    const rows = await sql<{ key: string; type: string | null }>(
      "SELECT key, jsonb_typeof(data::jsonb) AS type FROM progress",
    );
    expect(rows.filter((row) => row.type !== "object")).toEqual([]);
    const attempts = await sql<{ key: string }>(
      `SELECT key FROM progress WHERE key LIKE 'attempt:%'
         AND (jsonb_typeof(data::jsonb -> 'tasks') <> 'array'
           OR jsonb_typeof(data::jsonb -> 'answers') <> 'object')`,
    );
    expect(attempts).toEqual([]);
  });
});

describe("mocks of the real content bundle", () => {
  const mocks = (readSeedBundle() as unknown as ContentRecord[]).filter(
    (record): record is MockTest => record.kind === "mock-tests" && !record.unpublished,
  );

  it("has mocks to check", () => {
    expect(mocks.length).toBeGreaterThan(0);
  });

  it.each(mocks.map((mock) => [mock.id, mock] as const))(
    "%s starts with the tasks and time of lib/seed.json",
    async (_id, mock) => {
      const token = await guestToken(POST);
      const attempt = await start(token, mock.id);
      const ids = attempt.tasks.map((task) => task.id as string);
      if (mock.randomize) {
        expect(ids).toHaveLength(Math.min(mock.taskCount ?? 10, mock.taskIds.length));
        for (const id of ids) expect(mock.taskIds).toContain(id);
      } else {
        expect(ids).toEqual(mock.taskIds);
      }
      expect(new Set(ids).size).toBe(ids.length);
      expect(attempt.ends - attempt.started).toBe(mock.minutes * 60_000);
      for (const task of attempt.tasks) {
        expect(task).not.toHaveProperty("answer");
        expect(task).not.toHaveProperty("tests");
      }
    },
  );
});
