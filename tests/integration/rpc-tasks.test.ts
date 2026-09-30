// Practice tasks through /api/olympus: number grading, practice stars, reveal/hint, proofs and
// programs graded by the runner. Uses the synthetic course of tests/support/fixtures.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import { PRACTICE_STAR_GOAL } from "@/lib/domain/achievements.mjs";
import type { BootstrapResponse, TaskProgress } from "@/lib/domain/types";
import { FX } from "../support/fixtures";
import {
  bootstrap,
  configureEnv,
  guestToken,
  resetDatabase,
  rpc,
  startFakeRunner,
  type FakeRunner,
} from "../support/server";

let runner: FakeRunner;
let runnerMode: "ok" | "busy" | "down" | "reject" | "garbage" = "ok";

const [n1] = FX.numbers;
const [code1, code2] = FX.code;

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  runner = await startFakeRunner((body) => {
    if (runnerMode === "busy")
      return {
        status: 429,
        body: { error: { code: "RUNNER_BUSY", message: "busy" } },
        headers: { "retry-after": "3" },
      };
    if (runnerMode === "down")
      return {
        status: 503,
        body: {
          error: { code: "JUDGE0_UNAVAILABLE", message: "Judge0 не настроен: задайте JUDGE0_URL" },
        },
      };
    if (runnerMode === "reject")
      return { status: 422, body: { error: { message: "internal detail" } } };
    if (runnerMode === "garbage") return { body: { nope: true } };
    const tests = body.tests as { input: string; output: string | null }[];
    if (tests.length === 1 && tests[0].output === null)
      return { body: { correct: true, output: `echo:${tests[0].input}`, passed: 1, total: 1 } };
    const correct = body.code === FX.goodProgram;
    return {
      body: {
        correct,
        output: `Пройдено тестов: ${correct ? tests.length : 0} из ${tests.length}`,
        passed: correct ? tests.length : 0,
        total: tests.length,
      },
    };
  });
});
afterAll(() => runner.close());
beforeEach(() => {
  runnerMode = "ok";
  configureEnv({ RUNNER_URL: runner.url, RUNNER_TOKEN: "runner-secret" });
});

const progress = async (token: string) =>
  (await bootstrap<BootstrapResponse>(GET, { token })).body.progress;

const check = (token: string, id: string, answer: unknown) =>
  rpc<{ correct: boolean; practiceStar: boolean }>(POST, "check", { id, answer }, { token });

describe("number tasks", () => {
  it.each([
    [n1.answer, true],
    [` ${n1.answer} `, true],
    [`+${n1.answer}`, true],
    [`${n1.answer},0`, true],
    [`${Number(n1.answer) + 1}`, false],
  ])("answer %j → correct=%s", async (answer, correct) => {
    const token = await guestToken(POST);
    const response = await check(token, n1.id, answer);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ correct, output: "", practiceStar: false });
  });

  it("compares decimal answers with either separator", async () => {
    const decimal = FX.numbers.find((task) => task.answer?.includes("."))!;
    const token = await guestToken(POST);
    const comma = await check(token, decimal.id, decimal.answer!.replace(".", ","));
    expect(comma.body.correct).toBe(true);
    const off = await check(token, decimal.id, `${decimal.answer}1`);
    expect(off.body.correct).toBe(false);
  });

  it("grades «Что выведет программа?» tasks of informatics as numbers", async () => {
    const token = await guestToken(POST);
    expect((await check(token, FX.trace.id, FX.trace.answer)).body.correct).toBe(true);
    expect((await progress(token))[`task:${FX.trace.id}`]).toMatchObject({
      subject: "info",
      topicId: FX.infoTopic,
      correct: true,
    });
  });

  it.each([["abc"], [""], [null], ["1e3"]])(
    "rejects a non-number answer %j with 422",
    async (answer) => {
      const token = await guestToken(POST);
      const response = await check(token, n1.id, answer);
      expect(response).toMatchObject({ status: 422, body: { code: "INVALID_ANSWER" } });
      expect((response.body as unknown as { error: string }).error).toMatch(/число/);
    },
  );

  it("keeps the solved flag and counts attempts", async () => {
    const token = await guestToken(POST);
    await check(token, n1.id, n1.answer);
    await check(token, n1.id, `${Number(n1.answer) + 1}`);
    expect((await progress(token))[`task:${n1.id}`]).toEqual({
      title: n1.title,
      topicId: FX.mathTopic,
      subject: "math",
      correct: true,
      lastCorrect: false,
      attempts: 2,
      selfChecked: false,
    });
  });

  it(`awards the practice star on solve number ${PRACTICE_STAR_GOAL} of a topic`, async () => {
    expect(FX.numbers.length).toBeGreaterThan(PRACTICE_STAR_GOAL);
    const token = await guestToken(POST);
    const results = [];
    for (const task of FX.numbers.slice(0, PRACTICE_STAR_GOAL))
      results.push((await check(token, task.id, task.answer)).body.practiceStar);
    expect(results).toEqual([...Array(PRACTICE_STAR_GOAL - 1).fill(false), true]);
    expect((await progress(token))[`practice-star:${FX.mathTopic}`]).toMatchObject({
      type: "practice",
      subject: "math",
    });
    const next = FX.numbers[PRACTICE_STAR_GOAL];
    expect((await check(token, next.id, next.answer)).body.practiceStar).toBe(false);
  });

  it("does not count wrong answers towards the practice star", async () => {
    const token = await guestToken(POST);
    for (const task of FX.numbers.slice(0, PRACTICE_STAR_GOAL - 1))
      await check(token, task.id, task.answer);
    const wrong = FX.numbers[PRACTICE_STAR_GOAL - 1];
    expect((await check(token, wrong.id, "100500")).body.practiceStar).toBe(false);
    expect(await progress(token)).not.toHaveProperty(`practice-star:${FX.mathTopic}`);
  });
});

describe("reveal and hint", () => {
  it("returns hint and solution", async () => {
    const token = await guestToken(POST);
    const hint = await rpc<{ hint: string }>(POST, "hint", { id: n1.id }, { token });
    expect(hint.status).toBe(200);
    expect(hint.body.hint).toBe(n1.hint);
    const reveal = await rpc(POST, "reveal", { id: n1.id }, { token });
    expect(reveal.body).toEqual({ answer: n1.answer, solution: n1.solution });
  });

  it("reveals only the solution of a code task without a reference answer", async () => {
    const token = await guestToken(POST);
    const reveal = await rpc(POST, "reveal", { id: code1.id }, { token });
    expect(reveal).toMatchObject({ status: 200, body: { solution: code1.solution } });
    expect(reveal.body).not.toHaveProperty("answer");
    expect(reveal.body).not.toHaveProperty("tests");
  });

  it("marks a task solved after reveal and does not count it for stars", async () => {
    const token = await guestToken(POST);
    await rpc(POST, "reveal", { id: n1.id }, { token });
    expect((await progress(token))[`task:${n1.id}`]).toMatchObject({
      correct: false,
      attempts: 0,
      revealed: true,
    });
    const solved = await check(token, n1.id, n1.answer);
    expect(solved.body).toEqual({
      correct: true,
      output: "",
      practiceStar: false,
      solvedAfterReveal: true,
    });
    // The revealed task does not count: the star needs PRACTICE_STAR_GOAL other clean solves.
    const others = FX.numbers.slice(1, PRACTICE_STAR_GOAL + 1);
    const stars = [];
    for (const task of others)
      stars.push((await check(token, task.id, task.answer)).body.practiceStar);
    expect(stars).toEqual([...Array(PRACTICE_STAR_GOAL - 1).fill(false), true]);
  });

  it("does not mark an already solved task as revealed", async () => {
    const token = await guestToken(POST);
    await check(token, n1.id, n1.answer);
    await rpc(POST, "reveal", { id: n1.id }, { token });
    const value = (await progress(token))[`task:${n1.id}`] as TaskProgress;
    expect(value.revealed).toBeUndefined();
    expect(value.solvedAfterReveal).toBeUndefined();
  });
});

describe("proof tasks (self-check)", () => {
  it("accepts a boolean self-check and rejects anything else", async () => {
    const token = await guestToken(POST);
    const ok = await rpc(POST, "check", { id: FX.proof.id, correct: true }, { token });
    expect(ok.body).toEqual({ correct: true, output: "", practiceStar: false });
    expect((await progress(token))[`task:${FX.proof.id}`]).toMatchObject({
      selfChecked: true,
      correct: true,
    });
    const bad = await rpc(POST, "check", { id: FX.proof.id, correct: "yes" }, { token });
    expect(bad).toMatchObject({ status: 422, body: { code: "INVALID_SELF_CHECK" } });
  });
});

describe("code tasks through the runner", () => {
  it("grades code against hidden tests and never exposes them", async () => {
    const token = await guestToken(POST);
    const tests = code1.tests!;
    const good = await rpc(
      POST,
      "check",
      { id: code1.id, code: FX.goodProgram, language: "python" },
      { token },
    );
    expect(good.body).toEqual({
      correct: true,
      output: `Пройдено тестов: ${tests.length} из ${tests.length}`,
      practiceStar: false,
    });
    const request = runner.requests.at(-1)!;
    expect(request.headers.authorization).toBe("Bearer runner-secret");
    expect(request.body.tests).toEqual(tests);
    expect((await progress(token))[`task:${code1.id}`]).toMatchObject({
      subject: "info",
      correct: true,
    });
    const bad = await rpc(
      POST,
      "check",
      { id: code1.id, code: "print(0)", language: "python" },
      { token },
    );
    expect(bad.body).toMatchObject({ correct: false });
  });

  it("runs code with custom input without saving progress", async () => {
    const token = await guestToken(POST);
    const response = await rpc(
      POST,
      "run",
      { id: code1.id, code: "print(input())", language: "python", input: "5\n" },
      { token },
    );
    expect(response.body).toEqual({ correct: true, output: "echo:5\n", passed: 1, total: 1 });
    expect(runner.requests.at(-1)!.body.tests).toEqual([{ input: "5\n", output: null }]);
    expect(await progress(token)).not.toHaveProperty(`task:${code1.id}`);
  });

  it("rejects runs of non-code tasks (also tracing tasks of informatics) and oversized input", async () => {
    const token = await guestToken(POST);
    const before = runner.requests.length;
    for (const id of [n1.id, FX.trace.id]) {
      const notCode = await rpc(POST, "run", { id, code: "1", language: "python" }, { token });
      expect(notCode).toMatchObject({ status: 400, body: { code: "NOT_CODE_TASK" } });
    }
    const input = await rpc(
      POST,
      "run",
      { id: code1.id, code: "1", language: "python", input: 5 },
      { token },
    );
    expect(input).toMatchObject({ status: 422, body: { code: "INVALID_INPUT" } });
    const long = await rpc(
      POST,
      "run",
      { id: code1.id, code: "1", language: "python", input: "x".repeat(100_001) },
      { token },
    );
    expect(long).toMatchObject({ status: 422, body: { code: "INVALID_INPUT" } });
    expect(runner.requests.length).toBe(before);
  });

  it.each([
    ["busy", 429, "RUNNER_BUSY"],
    ["down", 503, "RUNNER_UNAVAILABLE"],
    ["reject", 422, "INVALID_CODE"],
    ["garbage", 503, "RUNNER_UNAVAILABLE"],
  ] as const)("maps a %s runner to %i %s without leaking its text", async (mode, status, code) => {
    runnerMode = mode;
    const token = await guestToken(POST);
    const response = await rpc(
      POST,
      "check",
      { id: code1.id, code: "x", language: "python" },
      { token },
    );
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(JSON.stringify(response.body)).not.toMatch(/Judge0|JUDGE0|internal detail|busy/);
    if (mode === "busy") expect(response.headers.get("retry-after")).toBe("3");
  });

  it("explains that the runner is not connected", async () => {
    configureEnv({ RUNNER_URL: "" });
    const token = await guestToken(POST);
    const response = await rpc(
      POST,
      "check",
      { id: code1.id, code: "x", language: "python" },
      { token },
    );
    expect(response).toMatchObject({ status: 503, body: { code: "RUNNER_UNAVAILABLE" } });
    expect(response.body.error).toMatch(/Твой код сохранён/);
    // ...and it really is: the submitted program is kept as the code draft.
    expect((await progress(token))[`code:${code1.id}`]).toEqual({
      code: "x",
      language: "python",
    });
    const run = await rpc(
      POST,
      "run",
      { id: code2.id, code: "y", language: "cpp", input: "" },
      { token },
    );
    expect(run.status).toBe(503);
    expect((await progress(token))[`code:${code2.id}`]).toEqual({
      code: "y",
      language: "cpp",
    });
  });

  it("validates code and language before calling the runner", async () => {
    const token = await guestToken(POST);
    const before = runner.requests.length;
    const language = await rpc(
      POST,
      "check",
      { id: code1.id, code: "x", language: "brainfuck" },
      { token },
    );
    expect(language).toMatchObject({ status: 422, body: { code: "INVALID_LANGUAGE" } });
    const long = await rpc(
      POST,
      "check",
      { id: code1.id, code: "x".repeat(50_001), language: "python" },
      { token },
    );
    expect(long).toMatchObject({ status: 422, body: { code: "INVALID_CODE" } });
    expect(runner.requests.length).toBe(before);
  });
});
