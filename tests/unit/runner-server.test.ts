import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  configFromEnv,
  createRunner,
  judgeOutcome,
  LIMITS,
  MESSAGES,
  normalizeOutput,
  oneLine,
  pickLanguageId,
  validateExecution,
} from "../../runner/server.mjs";

// ---------------------------------------------------------------------------
// Fake Judge0
// ---------------------------------------------------------------------------

type Judge0Result = {
  status: { id: number; description?: string };
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
};

interface Submission {
  source_code: string;
  language_id: number;
  stdin: string;
  enable_network: boolean;
}

interface FakeJudgeOptions {
  languages?: Array<{ id: number; name: string }>;
  /** HTTP status of GET /languages (default 200). */
  languagesStatus?: () => number;
  /** Poll responses of one submission; the last one repeats. */
  run?: (submission: Submission) => Judge0Result[];
  /** Delay before answering POST /submissions. */
  submitDelayMs?: number;
}

interface FakeJudge {
  url: string;
  submissions: Submission[];
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  polls: number;
  languagesCalls: number;
  options: FakeJudgeOptions;
  /** Resolves when the next submission arrives. */
  nextSubmission(): Promise<void>;
  close(): Promise<void>;
}

const LANGUAGES = [
  { id: 70, name: "Python (2.7.17)" },
  { id: 71, name: "Python (3.8.1)" },
  { id: 92, name: "Python (3.11.2)" },
  { id: 54, name: "C++ (GCC 9.2.0)" },
  { id: 105, name: "C++ (GCC 14.1.0)" },
  { id: 62, name: "Java (OpenJDK 13.0.1)" },
  { id: 63, name: "JavaScript (Node.js 12.14.0)" },
  { id: 67, name: "Pascal (FPC 3.0.4)" },
];

const accepted = (stdout: string): Judge0Result => ({
  status: { id: 3, description: "Accepted" },
  stdout,
});

/** "Program" of the fake: doubles the number on stdin; markers in the code change behaviour. */
function simulate(submission: Submission): Judge0Result[] {
  const code = submission.source_code;
  if (code.includes("COMPILE"))
    return [{ status: { id: 6 }, compile_output: "main.cpp:1: error: expected ';'" }];
  if (code.includes("ECHO_CRASH"))
    return submission.stdin === "2"
      ? [accepted("4\n")]
      : [
          {
            status: { id: 11, description: "Runtime Error (NZEC)" },
            stderr: `stdin was ${submission.stdin}`,
          },
        ];
  if (code.includes("CRASH"))
    return [
      { status: { id: 11, description: "Runtime Error (NZEC)" }, stderr: "ZeroDivisionError" },
    ];
  if (code.includes("SIGSEGV"))
    return [{ status: { id: 11, description: "Runtime Error (SIGSEGV)" } }];
  if (code.includes("SLOW")) return [{ status: { id: 5, description: "Time Limit Exceeded" } }];
  if (code.includes("BROKEN")) return [{ status: { id: 13, description: "Internal Error" } }];
  if (code.includes("HANG")) return [{ status: { id: 2, description: "Processing" } }];
  const doubled = `${Number(submission.stdin) * 2}  \r\n`;
  if (code.includes("QUEUE"))
    return [{ status: { id: 1 } }, { status: { id: 2 } }, { status: { id: 2 } }, accepted(doubled)];
  if (code.includes("WRONG")) return [accepted("42\n")];
  return [accepted(doubled)];
}

async function startFakeJudge(options: FakeJudgeOptions = {}): Promise<FakeJudge> {
  const queues = new Map<string, Judge0Result[]>();
  let waiters: Array<() => void> = [];
  const fake: Omit<FakeJudge, "url" | "close"> = {
    submissions: [],
    requests: [],
    polls: 0,
    languagesCalls: 0,
    options,
    nextSubmission: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      fake.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      const url = new URL(req.url ?? "/", "http://judge0");
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/languages") {
        fake.languagesCalls += 1;
        const status = options.languagesStatus?.() ?? 200;
        return reply(status, status === 200 ? (options.languages ?? LANGUAGES) : { error: "down" });
      }
      if (url.pathname === "/submissions" && req.method === "POST") {
        const submission = JSON.parse(raw) as Submission;
        fake.submissions.push(submission);
        const resolved = waiters;
        waiters = [];
        resolved.forEach((resolve) => resolve());
        if (options.submitDelayMs) await new Promise((r) => setTimeout(r, options.submitDelayMs));
        const token = `token-${fake.submissions.length}`;
        queues.set(token, (options.run ?? simulate)(submission));
        return reply(201, { token });
      }
      const match = /^\/submissions\/([^/]+)$/.exec(url.pathname);
      if (match && req.method === "GET") {
        fake.polls += 1;
        const queue = queues.get(decodeURIComponent(match[1]));
        if (!queue) return reply(404, { error: "unknown token" });
        return reply(200, queue.length > 1 ? queue.shift() : queue[0]);
      }
      return reply(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...fake,
    get polls() {
      return fake.polls;
    },
    get languagesCalls() {
      return fake.languagesCalls;
    },
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as FakeJudge;
}

// ---------------------------------------------------------------------------
// Runner under test
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type RunnerOptions = Parameters<typeof createRunner>[0];

async function startRunner(options: RunnerOptions = {}) {
  const logs: unknown[][] = [];
  const runner = createRunner({
    pollIntervalMs: 2,
    pollTimeoutMs: 2_000,
    submissionTimeoutMs: 2_000,
    log: (...args: unknown[]) => logs.push(args),
    ...options,
  });
  await new Promise<void>((resolve) => runner.server.listen(0, "127.0.0.1", resolve));
  const { port } = runner.server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => runner.server.close(() => resolve())));
  const url = `http://127.0.0.1:${port}`;
  return { runner, url, logs };
}

async function withJudge(options: FakeJudgeOptions = {}, runnerOptions: RunnerOptions = {}) {
  const judge = await startFakeJudge(options);
  cleanups.push(() => judge.close());
  const runner = await startRunner({ judge0Url: `${judge.url}/`, ...runnerOptions });
  return { judge, ...runner };
}

async function call(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  path = "/execute",
  method = "POST",
) {
  const response = await fetch(url + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

const graded = (code: string, tests = [{ input: "2", output: "4" }], language = "python") => ({
  code,
  language,
  tests,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("normalizeOutput ignores CRLF, trailing spaces and trailing blank lines", () => {
    expect(normalizeOutput("1 2  \r\n3\t\r\n\r\n")).toBe("1 2\n3");
    expect(normalizeOutput(null)).toBe("");
    expect(normalizeOutput("  lead")).toBe("  lead");
  });

  it("pickLanguageId chooses the newest matching Judge0 language", () => {
    expect(pickLanguageId(LANGUAGES, "python")).toBe(92);
    expect(pickLanguageId(LANGUAGES, "cpp")).toBe(105);
    expect(pickLanguageId(LANGUAGES, "kotlin")).toBeNull();
    expect(pickLanguageId(LANGUAGES, "brainfuck")).toBeNull();
    expect(pickLanguageId({ error: "x" }, "python")).toBeNull();
    expect(pickLanguageId([{ id: "abc", name: "Python (3.12)" }], "python")).toBeNull();
  });

  it.each([
    ["a non-object body", []],
    ["an unknown language", { code: "x", language: "ruby", tests: [{ input: "", output: "" }] }],
    [
      "an inherited property as language",
      { code: "x", language: "toString", tests: [{ input: "", output: "" }] },
    ],
    ["empty code", { code: "   ", language: "python", tests: [{ input: "", output: "" }] }],
    [
      "too long code",
      { code: "x".repeat(LIMITS.code + 1), language: "python", tests: [{ input: "", output: "" }] },
    ],
    ["no tests", { code: "x", language: "python", tests: [] }],
    [
      "too many tests",
      {
        code: "x",
        language: "python",
        tests: Array.from({ length: 21 }, () => ({ input: "", output: "" })),
      },
    ],
    ["a test without input", { code: "x", language: "python", tests: [{ output: "1" }] }],
    ["a numeric output", { code: "x", language: "python", tests: [{ input: "", output: 1 }] }],
    [
      "practice mode with several tests",
      {
        code: "x",
        language: "python",
        tests: [
          { input: "", output: null },
          { input: "", output: null },
        ],
      },
    ],
    [
      "a huge test",
      {
        code: "x",
        language: "python",
        tests: [{ input: "x".repeat(LIMITS.testText + 1), output: "" }],
      },
    ],
  ])("validateExecution rejects %s with 422", (_name, body) => {
    expect(() => validateExecution(body)).toThrow(
      expect.objectContaining({ status: 422, code: "INVALID_EXECUTION_REQUEST" }),
    );
  });

  it("validateExecution accepts graded and practice requests", () => {
    expect(() => validateExecution(graded("print(1)"))).not.toThrow();
    expect(() =>
      validateExecution(graded("print(1)", [{ input: "", output: null }] as never)),
    ).not.toThrow();
  });

  it("judgeOutcome maps Judge0 status ids", () => {
    expect(judgeOutcome({ status: { id: 1 } })).toEqual({ kind: "pending" });
    expect(judgeOutcome({ status: { id: 2 } })).toEqual({ kind: "pending" });
    expect(judgeOutcome({ status: { id: 3 }, stdout: "4\n" })).toEqual({
      kind: "completed",
      stdout: "4\n",
    });
    expect(judgeOutcome({ status: { id: 4 }, stdout: null })).toEqual({
      kind: "completed",
      stdout: "",
    });
    expect(judgeOutcome({ status: { id: 5 } })).toEqual({
      kind: "failed",
      output: MESSAGES.timeout,
    });
    expect(judgeOutcome({ status: { id: 6 }, compile_output: "boom" })).toEqual({
      kind: "failed",
      output: "Ошибка компиляции:\nboom",
    });
    expect(judgeOutcome({ status: { id: 12, description: "Runtime Error (Other)" } })).toEqual({
      kind: "failed",
      output: "Ошибка во время выполнения:\nRuntime Error (Other)",
      runtime: true,
    });
    expect(judgeOutcome({ status: { id: 7 } })).toEqual({
      kind: "failed",
      output: `Ошибка во время выполнения:\n${MESSAGES.runtimeFallback}`,
      runtime: true,
    });
    expect(judgeOutcome({ status: { id: 13, description: "Internal Error" } }).kind).toBe(
      "unavailable",
    );
    expect(judgeOutcome({ status: { id: 14 } }).kind).toBe("unavailable");
    expect(judgeOutcome(null).kind).toBe("unavailable");
  });

  it("configFromEnv applies defaults, bounds and URL normalisation", () => {
    expect(configFromEnv({})).toMatchObject({
      judge0Url: "",
      runnerToken: "",
      port: 8080,
      maxConcurrent: 4,
      requestLimit: 1_000_000,
    });
    expect(
      configFromEnv({
        JUDGE0_URL: " https://judge0.example// ",
        RUNNER_MAX_CONCURRENT: "99",
        RUNNER_REQUEST_LIMIT: "10",
        RUNNER_PORT: "abc",
        RUNNER_TOKEN: "secret",
        JUDGE0_AUTH_TOKEN: "j0",
      }),
    ).toMatchObject({
      judge0Url: "https://judge0.example",
      maxConcurrent: 16,
      requestLimit: 64_000,
      port: 8080,
      runnerToken: "secret",
      judge0Token: "j0",
    });
    expect(configFromEnv({ RUNNER_MAX_CONCURRENT: "0" }).maxConcurrent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /execute
// ---------------------------------------------------------------------------

describe("POST /execute", () => {
  it("grades every test against the hidden outputs", async () => {
    const { judge, url } = await withJudge();
    const response = await call(
      url,
      graded("print(int(input())*2)", [
        { input: "2", output: "4" },
        { input: "5", output: "10\n" },
      ]),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      correct: true,
      output: "Пройдено тестов: 2 из 2",
      passed: 2,
      total: 2,
    });
    expect(judge.submissions).toHaveLength(2);
    expect(judge.submissions[0]).toMatchObject({
      language_id: 92,
      stdin: "2",
      enable_network: false,
    });
    expect(judge.submissions[1].stdin).toBe("5");
  });

  it("reports a partially wrong program", async () => {
    const { url } = await withJudge();
    const response = await call(
      url,
      graded("WRONG", [
        { input: "21", output: "42" },
        { input: "1", output: "2" },
      ]),
    );
    expect(response.body).toEqual({
      correct: false,
      output: "Пройдено тестов: 1 из 2",
      passed: 1,
      total: 2,
    });
  });

  it("returns the program output for a practice run", async () => {
    const { url } = await withJudge();
    const response = await call(
      url,
      graded("print(int(input())*2)", [{ input: "7", output: null }] as never),
    );
    expect(response.body).toEqual({ correct: true, output: "14  \r\n", passed: 1, total: 1 });
  });

  it("stops at a compilation error and shows the compiler message", async () => {
    const { judge, url } = await withJudge();
    const response = await call(
      url,
      graded(
        "COMPILE",
        [
          { input: "1", output: "2" },
          { input: "2", output: "4" },
        ],
        "cpp",
      ),
    );
    expect(response.body).toEqual({
      correct: false,
      output: "Ошибка компиляции:\nmain.cpp:1: error: expected ';'",
      passed: 0,
      total: 2,
    });
    expect(judge.submissions).toHaveLength(1);
    expect(judge.submissions[0].language_id).toBe(105);
  });

  it("shows stderr of a runtime error, or the status description without stderr", async () => {
    const { url } = await withJudge();
    expect((await call(url, graded("CRASH"))).body.output).toBe(
      "Ошибка во время выполнения:\nZeroDivisionError",
    );
    expect((await call(url, graded("SIGSEGV"))).body.output).toBe(
      "Ошибка во время выполнения:\nRuntime Error (SIGSEGV)",
    );
  });

  it("never shows stderr of a hidden test (it could echo the test input)", async () => {
    const { url } = await withJudge();
    const tests = [
      { input: "2", output: "4" },
      { input: "secret-input", output: "x" },
    ];
    const hidden = (await call(url, graded("ECHO_CRASH", tests))).body;
    expect(hidden).toMatchObject({ correct: false, passed: 1, total: 2 });
    expect(hidden.output).toBe(
      `Ошибка во время выполнения:\n${MESSAGES.runtimeFallback} на тесте 2`,
    );
    expect(JSON.stringify(hidden)).not.toContain("secret-input");
    // The first test is the public example of the task; a practice run uses the child's input.
    const example = await call(url, graded("ECHO_CRASH", [{ input: "7", output: "14" }]));
    expect(example.body.output).toBe("Ошибка во время выполнения:\nstdin was 7");
    const practice = await call(
      url,
      graded("ECHO_CRASH", [{ input: "mine", output: null }] as never),
    );
    expect(practice.body.output).toBe("Ошибка во время выполнения:\nstdin was mine");
  });

  it("explains a time limit in child-friendly words", async () => {
    const { url } = await withJudge();
    const response = await call(url, graded("SLOW"));
    expect(response.body).toMatchObject({ correct: false, output: MESSAGES.timeout, passed: 0 });
  });

  it("polls while the submission is queued or processing", async () => {
    const { judge, url } = await withJudge();
    const response = await call(url, graded("QUEUE"));
    expect(response.body).toMatchObject({ correct: true, passed: 1 });
    expect(judge.polls).toBe(4);
    const poll = judge.requests.find((request) => request.url.startsWith("/submissions/token-1"));
    expect(poll?.url).toContain("base64_encoded=false");
  });

  it("gives up after the polling deadline", async () => {
    const { url } = await withJudge({}, { pollTimeoutMs: 30 });
    const response = await call(url, graded("HANG"));
    expect(response.body).toMatchObject({ correct: false, output: MESSAGES.timeout });
  });

  it("answers 503 on a Judge0 internal error without leaking details", async () => {
    const { url, logs } = await withJudge();
    const response = await call(url, graded("BROKEN"));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: "JUDGE0_UNAVAILABLE", message: MESSAGES.judgeUnavailable },
    });
    expect(JSON.stringify(logs)).toContain("Judge0 status 13");
  });

  it("answers 503 when Judge0 is not configured or unreachable, without naming env vars", async () => {
    const { url, logs } = await startRunner({ judge0Url: "" });
    const missing = await call(url, graded("x"));
    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe("JUDGE0_UNAVAILABLE");
    expect(missing.body.error.message).toBe(MESSAGES.judgeUnavailable);
    expect(missing.body.error.message).not.toMatch(/JUDGE0|Judge0|URL/);
    expect(JSON.stringify(logs)).toContain("JUDGE0_URL");

    const down = await startRunner({ judge0Url: "http://127.0.0.1:1" });
    expect((await call(down.url, graded("x"))).status).toBe(503);
  });

  it("forwards the Judge0 auth token", async () => {
    const { judge, url } = await withJudge({}, { judge0Token: "judge-secret" });
    await call(url, graded("x"));
    expect(
      judge.requests.every((request) => request.headers["x-auth-token"] === "judge-secret"),
    ).toBe(true);
  });

  it("caches languages, refreshes them for a missing language and never caches failures", async () => {
    let languagesUp = false;
    const languages = [...LANGUAGES];
    const { judge, url } = await withJudge({
      languages,
      languagesStatus: () => (languagesUp ? 200 : 500),
    });

    expect((await call(url, graded("x"))).status).toBe(503);
    languagesUp = true;
    expect((await call(url, graded("x"))).status).toBe(200);
    expect((await call(url, graded("x"))).status).toBe(200);
    expect(judge.languagesCalls).toBe(2);

    const kotlin = await call(url, graded("x", undefined, "kotlin"));
    expect(kotlin.status).toBe(503);
    expect(kotlin.body.error.code).toBe("LANGUAGE_UNAVAILABLE");
    languages.push({ id: 111, name: "Kotlin (2.1.10)" });
    expect((await call(url, graded("x", undefined, "kotlin"))).status).toBe(200);
    expect(judge.submissions.at(-1)?.language_id).toBe(111);
  });
});

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

describe("HTTP layer", () => {
  it("requires the bearer token when one is configured", async () => {
    const { url } = await withJudge({}, { runnerToken: "s3cret" });
    expect((await call(url, graded("x"))).status).toBe(401);
    const wrong = await call(url, graded("x"), { authorization: "Bearer nope" });
    expect(wrong).toMatchObject({ status: 401, body: { error: { code: "UNAUTHORIZED" } } });
    expect((await call(url, graded("x"), { authorization: "Bearer s3cret" })).status).toBe(200);
    // Health stays public for the Docker healthcheck.
    expect((await call(url, null, {}, "/health", "GET")).status).toBe(200);
  });

  it("is open without a configured token (internal Docker network)", async () => {
    const { url } = await withJudge();
    expect((await call(url, graded("x"))).status).toBe(200);
  });

  it("answers 404 for unknown paths and methods", async () => {
    const { url } = await withJudge();
    expect((await call(url, {}, {}, "/nope")).body).toEqual({
      error: { code: "NOT_FOUND", message: MESSAGES.notFound },
    });
    expect((await call(url, null, {}, "/execute", "GET")).status).toBe(404);
  });

  it("limits concurrent executions with 429 and Retry-After", async () => {
    const { judge, url, runner } = await withJudge({ submitDelayMs: 150 }, { maxConcurrent: 1 });
    const submitted = judge.nextSubmission();
    const first = call(url, graded("x"));
    await submitted;
    const second = await call(url, graded("x"));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("2");
    expect(second.body.error.code).toBe("RUNNER_BUSY");
    expect((await first).status).toBe(200);
    expect(runner.active).toBe(0);
    expect((await call(url, graded("x"))).status).toBe(200);
  });

  it("rejects bodies over the limit, declared or streamed", async () => {
    const { url } = await withJudge({}, { requestLimit: 1_000 });
    const declared = await call(url, graded("x".repeat(5_000)));
    expect(declared.status).toBe(413);
    expect(declared.body.error.code).toBe("PAYLOAD_TOO_LARGE");

    const streamed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${url}/execute`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify(graded("x".repeat(3_000))));
      req.end();
    });
    expect(streamed.status).toBe(413);
    expect(JSON.parse(streamed.body).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers 400 for invalid JSON and 422 for an invalid request", async () => {
    const { url } = await withJudge();
    expect((await call(url, "{not json")).body).toEqual({
      error: { code: "BAD_REQUEST", message: MESSAGES.badJson },
    });
    const invalid = await call(url, { code: "x", language: "python", tests: [] });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe("INVALID_EXECUTION_REQUEST");
  });
});

describe("GET /health", () => {
  it("is degraded but healthy without Judge0", async () => {
    const { url } = await startRunner({ judge0Url: "" });
    const response = await call(url, null, {}, "/health", "GET");
    expect(response).toMatchObject({
      status: 200,
      body: { status: "degraded", judge0: "not_configured" },
    });
  });

  it("reports the number of Judge0 languages", async () => {
    const { url } = await withJudge();
    const response = await call(url, null, {}, "/health", "GET");
    expect(response).toMatchObject({
      status: 200,
      body: { status: "ok", judge0: "ok", languages: LANGUAGES.length },
    });
  });

  it("answers 503 when Judge0 is down, without the error text", async () => {
    const { url } = await withJudge({ languagesStatus: () => 502 });
    const response = await call(url, null, {}, "/health", "GET");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "degraded", judge0: "unavailable" });
  });
});

describe("execute() without HTTP", () => {
  it("can be used directly and reports unexpected failures as RunnerError", async () => {
    const judge = await startFakeJudge();
    cleanups.push(() => judge.close());
    const runner = createRunner({ judge0Url: judge.url, pollIntervalMs: 1, log: () => undefined });
    await expect(runner.execute(graded("print(int(input())*2)"))).resolves.toEqual({
      correct: true,
      output: "Пройдено тестов: 1 из 1",
      passed: 1,
      total: 1,
    });
    await expect(runner.execute({ code: "", language: "python", tests: [] })).rejects.toMatchObject(
      {
        status: 422,
      },
    );
  });
});

describe("oneLine", () => {
  it("keeps a log entry on one line and bounded", () => {
    expect(oneLine("bad\n[runner] OK: fake entry\r\u2028x")).toBe("bad [runner] OK: fake entry x");
    expect(oneLine("x".repeat(600))).toHaveLength(500);
    expect(oneLine(42)).toBe("42");
  });
});
