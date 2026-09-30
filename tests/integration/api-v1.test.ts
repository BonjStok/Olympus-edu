// The DATA-API.yaml scenario against the route handlers, plus the documented error statuses.
// The scenario runs on the real content bundle (ids and answers from test-data.json and
// DATA-API.yaml, expectations derived from lib/seed.json); error and edge cases use the synthetic
// fixtures of tests/support/fixtures.ts.
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { GET as content } from "@/app/api/v1/content/route";
import { GET as health } from "@/app/api/v1/health/route";
import { POST as lessonView } from "@/app/api/v1/lessons/[id]/view/route";
import { POST as finish } from "@/app/api/v1/mock-attempts/[id]/finish/route";
import { PATCH as save } from "@/app/api/v1/mock-attempts/[id]/route";
import { POST as startMock } from "@/app/api/v1/mocks/[id]/start/route";
import { POST as register } from "@/app/api/v1/olympiads/[id]/register/route";
import { GET as profile } from "@/app/api/v1/profile/route";
import { POST as check } from "@/app/api/v1/tasks/[id]/check/route";
import { POST as reset } from "@/app/api/v1/test/reset/route";
import { GET as topic } from "@/app/api/v1/topics/[id]/route";
import type { ContentRecord, Lesson, MockTest, Task } from "@/lib/domain/types";
import packageJson from "@/package.json";
import { readSeedBundle } from "../../scripts/seed.mjs";
import { jsonPath, readDataApi, substitute, type DataApiCheck } from "../support/data-api";
import { correctAnswers, FIXTURE_RECORDS, FX } from "../support/fixtures";
import { documentedStatuses, type Operation } from "../support/openapi";
import {
  configureEnv,
  ORIGIN,
  publishedBundleIds,
  resetDatabase,
  sql,
  TEST_API_PASSWORD,
  toApiResponse,
} from "../support/server";

type Handler = (
  req: Request,
  context?: { params?: Promise<Record<string, string>> },
) => Promise<Response>;
const data = JSON.parse(fs.readFileSync("test-data.json", "utf8"));
const bundle = readSeedBundle() as unknown as ContentRecord[];
const bundleRecord = <T extends ContentRecord>(id: string) =>
  bundle.find((record) => record.id === id) as T;
const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
const [n1, n2] = FX.numbers;
const fixtureMock = FX.mocks.math;
/** Every (operation, status) seen in this suite; each must be documented in openapi.yaml. */
const observed = new Map<Operation, Set<number>>();

async function call(
  handler: Handler,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string | null;
    id?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  const req = new Request(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers, body });
  const response = await handler(req, {
    params: Promise.resolve<Record<string, string>>(options.id ? { id: options.id } : {}),
  });
  const template = options.id ? path.replace(/^(\/api\/v1\/[^/]+\/)[^/]+/, "$1{id}") : path;
  const operation = `${options.method ?? "GET"} ${template}` as Operation;
  observed.set(operation, (observed.get(operation) ?? new Set()).add(response.status));
  return toApiResponse<Record<string, unknown>>(response);
}

let token: string;

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  configureEnv();
  const response = await call(login, "/api/v1/auth/login", {
    method: "POST",
    body: { username: "test_user", password: TEST_API_PASSWORD },
  });
  token = response.body.accessToken as string;
});
beforeEach(() => configureEnv());

afterAll(() => {
  const documented = documentedStatuses();
  const undocumented: string[] = [];
  for (const [operation, statuses] of observed) {
    const declared = documented.get(operation);
    if (!declared) undocumented.push(`${operation} (operation)`);
    else
      for (const status of statuses)
        if (!declared.has(status)) undocumented.push(`${operation} ${status}`);
  }
  expect(undocumented).toEqual([]);
  // The scenario must have exercised every documented v1 operation.
  const v1 = [...documented.keys()].filter((operation) => operation.includes("/api/v1/"));
  expect(v1.filter((operation) => !observed.has(operation))).toEqual([]);
});

describe("openapi.yaml", () => {
  it("declares only operations that exist as route handlers", async () => {
    for (const operation of documentedStatuses().keys()) {
      const [method, path] = operation.split(" ");
      const file = `app${path.replace("{id}", "[id]")}/route.ts`;
      expect(fs.existsSync(file), file).toBe(true);
      const module = (await import(/* @vite-ignore */ `@/${file}`)) as Record<string, unknown>;
      expect(typeof module[method], operation).toBe("function");
    }
  });
});

describe("DATA-API scenario", () => {
  it("passes every documented check in order, twice (repeatable)", async () => {
    for (let round = 0; round < 2; round++) {
      const healthResponse = await call(health, "/api/v1/health");
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.headers.get("content-type")).toMatch(/^application\/json/);
      expect(healthResponse.body).toEqual({
        status: "ok",
        database: "ok",
        version: packageJson.version,
      });

      const loginResponse = await call(login, "/api/v1/auth/login", {
        method: "POST",
        body: { username: "test_user", password: TEST_API_PASSWORD },
      });
      expect(loginResponse.body).toEqual({
        accessToken: token,
        tokenType: "Bearer",
        role: "test_user",
        userId: "test:evaluator",
      });

      expect((await call(reset, "/api/v1/test/reset", { method: "POST", token })).body).toEqual({
        ok: true,
        userId: "test:evaluator",
        reset: true,
      });

      const catalogue = await call(content, "/api/v1/content", { token });
      const listed = (catalogue.body.records as { id: string }[]).map((record) => record.id);
      expect(catalogue.body.count).toBe(listed.length);
      expect(listed.sort()).toEqual(
        [...publishedBundleIds(), ...FIXTURE_RECORDS.map((record) => record.id)].sort(),
      );

      const topicResponse = await call(topic, `/api/v1/topics/${data.topicId}`, {
        token,
        id: data.topicId,
      });
      expect(topicResponse.status).toBe(200);
      expect(Object.keys(topicResponse.body).sort()).toEqual(["lessons", "tasks", "topic"]);
      const children = bundle.filter(
        (record): record is Lesson | Task =>
          (record.kind === "lessons" || record.kind === "tasks") && record.topicId === data.topicId,
      );
      const ids = (items: unknown) => (items as { id: string }[]).map((item) => item.id);
      expect(ids(topicResponse.body.lessons)).toEqual(
        children
          .filter((item) => item.kind === "lessons")
          .sort(byOrder)
          .map((item) => item.id),
      );
      expect(ids(topicResponse.body.tasks)).toEqual(
        children
          .filter((item) => item.kind === "tasks")
          .sort(byOrder)
          .map((item) => item.id),
      );
      expect(ids(topicResponse.body.lessons)).toContain(data.lessonId);
      for (const task of topicResponse.body.tasks as Record<string, unknown>[]) {
        expect(task).not.toHaveProperty("answer");
        expect(task).not.toHaveProperty("tests");
      }

      const view = await call(lessonView, `/api/v1/lessons/${data.lessonId}/view`, {
        method: "POST",
        token,
        id: data.lessonId,
      });
      expect(view.body).toEqual({ ok: true, lessonId: data.lessonId, completed: true });

      const checked = await call(check, `/api/v1/tasks/${data.numericTask.id}/check`, {
        method: "POST",
        token,
        id: data.numericTask.id,
        body: { answer: data.numericTask.correctAnswer },
      });
      expect(checked.body).toEqual({
        taskId: data.numericTask.id,
        correct: true,
        output: "",
        practiceStar: false,
      });

      const registered = await call(register, `/api/v1/olympiads/${data.olympiadId}/register`, {
        method: "POST",
        token,
        id: data.olympiadId,
        body: { registered: true },
      });
      expect(registered.body).toEqual({ ok: true, olympiadId: data.olympiadId, registered: true });

      const started = await call(startMock, `/api/v1/mocks/${data.mockId}/start`, {
        method: "POST",
        token,
        id: data.mockId,
      });
      expect(started.status).toBe(201);
      const attempt = started.body.attempt as { id: string; finished: boolean; tasks: Task[] };
      expect(attempt.finished).toBe(false);
      const mock = bundleRecord<MockTest>(data.mockId);
      expect(attempt.tasks.map((task) => task.id)).toEqual(mock.taskIds);
      // test-data.json answers every task of the mock with the answer of the content.
      expect(Object.keys(data.mockAnswers).sort()).toEqual([...mock.taskIds].sort());
      const fullScore = mock.taskIds.reduce(
        (sum, id) => sum + (bundleRecord<Task>(id).points ?? 1),
        0,
      );

      const firstTwo = Object.fromEntries(Object.entries(data.mockAnswers).slice(0, 2));
      const saved = await call(save, `/api/v1/mock-attempts/${attempt.id}`, {
        method: "PATCH",
        token,
        id: attempt.id,
        body: { answers: firstTwo },
      });
      expect(saved.body).toEqual({ ok: true, attemptId: attempt.id, saved: true });

      const finished = await call(finish, `/api/v1/mock-attempts/${attempt.id}/finish`, {
        method: "POST",
        token,
        id: attempt.id,
        body: { answers: data.mockAnswers },
      });
      const result = finished.body.attempt as {
        finished: boolean;
        score: number;
        max: number;
        pending: number;
        results: { status: string }[];
        tasks: object[];
      };
      expect(result.finished).toBe(true);
      expect(result.score).toBe(fullScore);
      expect(result.max).toBe(fullScore);
      expect(result.pending).toBe(0);
      expect(result.results.every((item) => item.status === "correct")).toBe(true);
      for (const task of result.tasks) expect(task).not.toHaveProperty("tests");

      const me = await call(profile, "/api/v1/profile", { token });
      expect(me.body.user).toEqual({ id: "test:evaluator", role: "test_user" });
      expect(me.body.progress).toHaveProperty(`lesson:${data.lessonId}`);
      expect(me.body.progress).toHaveProperty(`registration:${data.olympiadId}`);
      expect(
        (me.body.progress as Record<string, unknown>)[`task:${data.numericTask.id}`],
      ).toMatchObject({ correct: true, attempts: 1 });
      expect(typeof me.body.updatedAt).toBe("number");
    }
    await call(reset, "/api/v1/test/reset", { method: "POST", token });
    expect((await call(profile, "/api/v1/profile", { token })).body).toMatchObject({
      progress: {},
      updatedAt: null,
    });
  });

  it("runs the checks of DATA-API.yaml in order, as the evaluator does, twice", async () => {
    const api = readDataApi();
    const handlers: Record<string, Handler> = {
      "GET /api/v1/health": health,
      "POST /api/v1/auth/login": login,
      "POST /api/v1/test/reset": reset,
      "GET /api/v1/content": content,
      "GET /api/v1/topics/{id}": topic,
      "POST /api/v1/lessons/{id}/view": lessonView,
      "POST /api/v1/tasks/{id}/check": check,
      "POST /api/v1/olympiads/{id}/register": register,
      "POST /api/v1/mocks/{id}/start": startMock,
      "PATCH /api/v1/mock-attempts/{id}": save,
      "POST /api/v1/mock-attempts/{id}/finish": finish,
      "GET /api/v1/profile": profile,
    };
    const vars: Record<string, string> = {
      TEST_API_USERNAME: "test_user",
      TEST_API_PASSWORD,
    };

    const run = async (item: DataApiCheck) => {
      const handler = handlers[`${item.method} ${item.path}`];
      expect(handler, `${item.id}: no handler for ${item.method} ${item.path}`).toBeDefined();
      const request = substitute(item.request ?? {}, vars);
      const id = request.path?.id;
      const started = Date.now();
      const response = await call(handler, id ? item.path.replace("{id}", id) : item.path, {
        method: item.method,
        id,
        // HTTP header names are case-insensitive: one entry per header, as a real client sends.
        headers: Object.fromEntries(
          Object.entries({ ...api.api.defaultHeaders, ...request.headers }).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
        body: request.body,
      });
      expect(Date.now() - started, `${item.id} took too long`).toBeLessThan(
        item.timeoutMs ?? 5_000,
      );
      expect(item.expected.statusCodes, `${item.id}: ${JSON.stringify(response.body)}`).toContain(
        response.status,
      );
      if (item.expected.contentType)
        expect(response.headers.get("content-type")).toMatch(
          new RegExp(`^${item.expected.contentType}`),
        );
      for (const field of item.expected.requiredFields ?? [])
        expect(response.body, `${item.id}: ${field}`).toHaveProperty(field);
      const schema = item.expected.bodySchema as
        { properties?: Record<string, { type: string }> } | undefined;
      for (const [field, { type }] of Object.entries(schema?.properties ?? {})) {
        const value = response.body[field];
        const actual = Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
        expect(actual, `${item.id}: type of ${field}`).toBe(type);
      }
      for (const [name, path] of Object.entries(item.extract ?? {})) {
        const value = jsonPath(response.body, path);
        expect(typeof value, `${item.id}: ${path}`).toBe("string");
        vars[name] = value as string;
      }
      return response.body;
    };

    for (let round = 0; round < 2; round++) {
      for (const item of api.checks) {
        const body = await run(item);
        // The answers of DATA-API.yaml are the content's answers: the task is solved and the
        // finished mock gets the full score.
        if (item.path === "/api/v1/tasks/{id}/check") expect(body.correct).toBe(true);
        if (item.path === "/api/v1/mock-attempts/{id}/finish") {
          const attempt = body.attempt as { score: number; max: number; pending: number };
          expect(attempt.max).toBeGreaterThan(0);
          expect(attempt).toMatchObject({ score: attempt.max, pending: 0 });
        }
      }
      for (const item of api.cleanup ?? []) await run(item);
      expect(
        (await call(profile, "/api/v1/profile", { token: vars.accessToken })).body,
      ).toMatchObject({ progress: {}, updatedAt: null });
    }
  });

  it("finishes without a body", async () => {
    const started = await call(startMock, `/api/v1/mocks/${fixtureMock.id}/start`, {
      method: "POST",
      token,
      id: fixtureMock.id,
    });
    const id = (started.body.attempt as { id: string }).id;
    const finished = await call(finish, `/api/v1/mock-attempts/${id}/finish`, {
      method: "POST",
      token,
      id,
    });
    expect(finished.status).toBe(200);
    expect(finished.body.attempt).toMatchObject({ finished: true, score: 0 });
  });
});

describe("errors", () => {
  it("uses the documented error body", async () => {
    const response = await call(content, "/api/v1/content");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a wrong token and unconfigured accounts", async () => {
    expect((await call(profile, "/api/v1/profile", { token: "0".repeat(64) })).status).toBe(401);
    configureEnv({ TEST_API_PASSWORD: "" });
    const response = await call(profile, "/api/v1/profile", { token });
    expect(response).toMatchObject({
      status: 503,
      body: { error: { code: "TEST_ACCOUNT_NOT_CONFIGURED" } },
    });
  });

  it.each([
    ["GET", topic, "/api/v1/topics/nope", "nope", "TOPIC_NOT_FOUND"],
    ["GET", topic, `/api/v1/topics/${n1.id}`, n1.id, "TOPIC_NOT_FOUND"],
    ["POST", lessonView, "/api/v1/lessons/%2e%2e/view", "..", "LESSON_NOT_FOUND"],
    ["POST", check, "/api/v1/tasks/draft/check", "draft", "TASK_NOT_FOUND"],
    ["POST", register, "/api/v1/olympiads/nope/register", "nope", "OLYMPIAD_NOT_FOUND"],
    ["POST", startMock, "/api/v1/mocks/nope/start", "nope", "MOCK_NOT_FOUND"],
    ["PATCH", save, "/api/v1/mock-attempts/nope", "nope", "ATTEMPT_NOT_FOUND"],
    ["POST", finish, "/api/v1/mock-attempts/nope/finish", "nope", "ATTEMPT_NOT_FOUND"],
  ] as const)("%s %s answers 404", async (method, handler, path, id, code) => {
    const body = method === "GET" ? undefined : { answer: "1", registered: true, answers: {} };
    const response = await call(handler as Handler, path, { method, token, id, body });
    expect(response).toMatchObject({ status: 404, body: { error: { code } } });
  });

  it("validates check and register bodies", async () => {
    const taskPath = `/api/v1/tasks/${n1.id}/check`;
    const wrongType = await call(check, taskPath, {
      method: "POST",
      token,
      id: n1.id,
      body: `answer=${n1.answer}`,
      headers: { "content-type": "text/plain" },
    });
    expect(wrongType).toMatchObject({
      status: 415,
      body: { error: { code: "UNSUPPORTED_MEDIA_TYPE" } },
    });
    const notNumber = await call(check, taskPath, {
      method: "POST",
      token,
      id: n1.id,
      body: { answer: "три" },
    });
    expect(notNumber).toMatchObject({ status: 422, body: { error: { code: "INVALID_ANSWER" } } });
    const brokenJson = await call(check, taskPath, {
      method: "POST",
      token,
      id: n1.id,
      body: "{",
    });
    expect(brokenJson).toMatchObject({ status: 400, body: { error: { code: "INVALID_JSON" } } });
    const tooLarge = await call(check, taskPath, {
      method: "POST",
      token,
      id: n1.id,
      body: { answer: n1.answer, padding: "x".repeat(300_000) },
    });
    expect(tooLarge).toMatchObject({ status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE" } } });
    const flag = await call(register, `/api/v1/olympiads/${FX.olympiad.id}/register`, {
      method: "POST",
      token,
      id: FX.olympiad.id,
      body: { registered: "yes" },
    });
    expect(flag).toMatchObject({ status: 422, body: { error: { code: "INVALID_REGISTERED" } } });
  });

  it("answers 409 when saving a finished or expired attempt", async () => {
    const started = await call(startMock, `/api/v1/mocks/${fixtureMock.id}/start`, {
      method: "POST",
      token,
      id: fixtureMock.id,
    });
    const id = (started.body.attempt as { id: string }).id;
    await sql(
      `UPDATE progress SET data = jsonb_set(data::jsonb, '{ends}', to_jsonb($2::bigint))::text WHERE key = $1`,
      [`attempt:${id}`, Date.now() - 60_000],
    );
    const expired = await call(save, `/api/v1/mock-attempts/${id}`, {
      method: "PATCH",
      token,
      id,
      body: { answers: {} },
    });
    expect(expired).toMatchObject({
      status: 409,
      body: { error: { code: "ATTEMPT_TIME_EXPIRED" } },
    });
    await call(finish, `/api/v1/mock-attempts/${id}/finish`, { method: "POST", token, id });
    const finished = await call(save, `/api/v1/mock-attempts/${id}`, {
      method: "PATCH",
      token,
      id,
      body: { answers: {} },
    });
    expect(finished).toMatchObject({ status: 409, body: { error: { code: "ATTEMPT_FINISHED" } } });
    const invalid = await call(save, `/api/v1/mock-attempts/${id}`, {
      method: "PATCH",
      token,
      id,
      body: { answers: [] },
    });
    expect(invalid).toMatchObject({ status: 422, body: { error: { code: "INVALID_ANSWERS" } } });
  });

  it("ignores answers to tasks outside the attempt (fixed DATA-API answer map)", async () => {
    const started = await call(startMock, `/api/v1/mocks/${fixtureMock.id}/start`, {
      method: "POST",
      token,
      id: fixtureMock.id,
    });
    const id = (started.body.attempt as { id: string }).id;
    const saved = await call(save, `/api/v1/mock-attempts/${id}`, {
      method: "PATCH",
      token,
      id,
      body: { answers: { [n1.id]: n1.answer, "task-of-another-mock": "5" } },
    });
    expect(saved).toMatchObject({ status: 200, body: { ok: true, saved: true } });
    // Numbers are accepted as text answers on /api/v1.
    const finished = await call(finish, `/api/v1/mock-attempts/${id}/finish`, {
      method: "POST",
      token,
      id,
      body: { answers: { [n2.id]: Number(n2.answer), "task-of-another-mock": "5" } },
    });
    expect(finished.status).toBe(200);
    const attempt = finished.body.attempt as {
      answers: Record<string, unknown>;
      results: { id: string; status: string }[];
    };
    expect(attempt.answers).toEqual({ [n1.id]: n1.answer, [n2.id]: n2.answer });
    expect(attempt.results.slice(0, 2)).toMatchObject([
      { id: n1.id, status: "correct" },
      { id: n2.id, status: "correct" },
    ]);
  });

  it("gives the full score for correct answers to every task (evaluator's finish check)", async () => {
    const started = await call(startMock, `/api/v1/mocks/${fixtureMock.id}/start`, {
      method: "POST",
      token,
      id: fixtureMock.id,
    });
    const id = (started.body.attempt as { id: string }).id;
    const finished = await call(finish, `/api/v1/mock-attempts/${id}/finish`, {
      method: "POST",
      token,
      id,
      body: { answers: correctAnswers(fixtureMock.taskIds) },
    });
    const attempt = finished.body.attempt as { score: number; max: number; pending: number };
    expect(attempt.max).toBeGreaterThan(0);
    expect(attempt).toMatchObject({ score: attempt.max, pending: 0 });
  });

  it("rate-limits failed logins per X-Real-IP (shared with the admin login)", async () => {
    const attempt = (ip: string, password = "wrong") =>
      call(login, "/api/v1/auth/login", {
        method: "POST",
        body: { username: "test_user", password },
        headers: { "x-real-ip": ip, "x-forwarded-for": `${Math.random()}` },
      });
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt("192.0.2.1")).status);
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(401));
    expect(statuses.slice(9)).toEqual([429, 429]);
    const blocked = await attempt("192.0.2.1", TEST_API_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await attempt("192.0.2.2", TEST_API_PASSWORD)).status).toBe(200);
  });

  it("validates the login body", async () => {
    const format = await call(login, "/api/v1/auth/login", {
      method: "POST",
      body: { username: 1, password: [] },
    });
    expect(format).toMatchObject({
      status: 422,
      body: { error: { code: "INVALID_CREDENTIALS_FORMAT" } },
    });
    const media = await call(login, "/api/v1/auth/login", {
      method: "POST",
      body: "username=a",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(media.status).toBe(415);
  });

  it("reports a degraded health status when the database is down", async () => {
    const url = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/none";
    try {
      const response = await call(health, "/api/v1/health");
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: "degraded",
        database: "unavailable",
        version: packageJson.version,
      });
    } finally {
      process.env.DATABASE_URL = url;
    }
  });

  it("does not seed or lock anything in health", async () => {
    await sql("DELETE FROM imports WHERE id = 'bundle'");
    expect((await call(health, "/api/v1/health")).status).toBe(200);
    expect(await sql("SELECT 1 FROM imports WHERE id = 'bundle'")).toHaveLength(0);
  });
});
