// Thin adapter to a separately deployed Judge0 CE sandbox.
// This service never executes untrusted user code itself: it validates the request, submits the
// code to Judge0, polls for the result and compares the program output with the expected one.
//
// HTTP contract (used by lib/services/runner.ts):
//   GET  /health   → 200 { status: "ok", judge0: "ok", languages } | 200 { status: "degraded",
//                    judge0: "not_configured" } | 503 { status: "degraded", judge0: "unavailable" }
//   POST /execute  (Authorization: Bearer RUNNER_TOKEN when configured)
//                  { code, language, tests: [{ input, output | null }] }
//                  → 200 { correct, output, passed, total }
//   Errors: { error: { code, message } } with 400, 401, 404, 413, 422, 429, 500 or 503.
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

/** @typedef {"python" | "cpp" | "java" | "javascript" | "kotlin" | "pascal"} Language */

/**
 * @typedef {object} RunnerConfig
 * @property {string} judge0Url Base URL of Judge0 without a trailing slash ("" = not configured).
 * @property {string} runnerToken Bearer token expected from the web app ("" = no auth, local only).
 * @property {string} judge0Token Optional `X-Auth-Token` for Judge0.
 * @property {number} maxConcurrent Parallel /execute requests before answering 429.
 * @property {number} requestLimit Maximum request body size in bytes.
 * @property {number} pollIntervalMs Delay between result polls.
 * @property {number} pollTimeoutMs How long to wait for one submission before giving up.
 * @property {number} submissionTimeoutMs Timeout of a single HTTP call to Judge0.
 * @property {typeof fetch} fetch
 * @property {(...args: unknown[]) => void} log Where technical details are logged.
 */

/**
 * @typedef {{ id?: number | string; name?: string }} Judge0Language
 * @typedef {{
 *   status?: { id?: number | string; description?: string } | null;
 *   stdout?: string | null;
 *   stderr?: string | null;
 *   compile_output?: string | null;
 *   message?: string | null;
 * }} Judge0Result
 * @typedef {{ kind: "pending" }
 *   | { kind: "completed"; stdout: string }
 *   | { kind: "failed"; output: string; runtime?: true }
 *   | { kind: "unavailable"; detail: string }} JudgeOutcome
 * @typedef {{ input: string; output: string | null }} ExecutionTest
 * @typedef {{ code: string; language: Language; tests: ExecutionTest[] }} ExecutionRequest
 * @typedef {{ correct: boolean; output: string; passed: number; total: number }} ExecutionResult
 */

export const LANGUAGE_PATTERNS = Object.freeze({
  python: /^Python \(3/i,
  cpp: /^C\+\+/i,
  java: /^Java \(/i,
  javascript: /^JavaScript/i,
  kotlin: /^Kotlin/i,
  pascal: /^Pascal/i,
});

export const LIMITS = Object.freeze({
  code: 50_000,
  tests: 20,
  testText: 100_000,
  stdout: 100_000,
  output: 10_000,
});

/** Texts shown to children (through the web app). Technical details only go to the log. */
export const MESSAGES = Object.freeze({
  timeout: "Программа работает слишком долго. Проверь циклы и попробуй решение побыстрее",
  compile: "Ошибка компиляции:\n",
  runtime: "Ошибка во время выполнения:\n",
  runtimeFallback: "Программа завершилась с ошибкой",
  judgeUnavailable: "Проверка программ временно недоступна. Попробуй позже",
  languageUnavailable: "Этот язык сейчас недоступен для проверки. Выбери другой язык",
  busy: "Сейчас проверяется много программ. Попробуй через пару секунд",
  unauthorized: "Нет доступа к проверке программ",
  notFound: "Такого адреса нет",
  tooLarge: "Программа или тесты слишком большие",
  badJson: "Некорректный JSON в запросе",
  internal: "Не удалось проверить программу. Попробуй ещё раз",
});

export class RunnerError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {string} [detail] technical detail for the log, never sent to the client
   */
  constructor(status, code, message, detail) {
    super(message);
    this.name = "RunnerError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const invalid = (/** @type {string} */ message) =>
  new RunnerError(422, "INVALID_EXECUTION_REQUEST", message);
const judgeUnavailable = (/** @type {string} */ detail) =>
  new RunnerError(503, "JUDGE0_UNAVAILABLE", MESSAGES.judgeUnavailable, detail);

/** Log-safe text: control characters (line breaks included) become spaces, at most 500 chars. */
export function oneLine(/** @type {unknown} */ value) {
  return String(value)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\p{Cc}+/gu, " ")
    .slice(0, 500);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function intInRange(value, fallback, min, max) {
  const number = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/**
 * Reads the runner configuration from environment variables.
 * @param {Record<string, string | undefined>} [env]
 */
export function configFromEnv(env = process.env) {
  return {
    judge0Url: String(env.JUDGE0_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    runnerToken: String(env.RUNNER_TOKEN || ""),
    judge0Token: String(env.JUDGE0_AUTH_TOKEN || ""),
    port: intInRange(env.RUNNER_PORT, 8080, 1, 65_535),
    maxConcurrent: intInRange(env.RUNNER_MAX_CONCURRENT, 4, 1, 16),
    requestLimit: intInRange(env.RUNNER_REQUEST_LIMIT, 1_000_000, 64_000, 10_000_000),
    pollIntervalMs: 300,
    pollTimeoutMs: 20_000,
    submissionTimeoutMs: 45_000,
  };
}

/** Output comparison ignores trailing spaces on lines, CRLF and trailing empty lines. */
export function normalizeOutput(/** @type {unknown} */ value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trimEnd();
}

/**
 * Throws a 422 `RunnerError` when the request is not a valid execution request.
 * @param {unknown} body
 * @returns {asserts body is ExecutionRequest}
 */
export function validateExecution(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw invalid("Нужен объект с полями code, language и tests");
  const request = /** @type {Record<string, unknown>} */ (body);
  if (typeof request.language !== "string" || !Object.hasOwn(LANGUAGE_PATTERNS, request.language))
    throw invalid("Неподдерживаемый язык программирования");
  if (typeof request.code !== "string" || !request.code.trim() || request.code.length > LIMITS.code)
    throw invalid("Код отсутствует или слишком длинный");
  const tests = request.tests;
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > LIMITS.tests)
    throw invalid(`Нужно от 1 до ${LIMITS.tests} тестов`);
  for (const test of tests) {
    if (
      typeof test !== "object" ||
      test === null ||
      typeof test.input !== "string" ||
      (test.output !== null && typeof test.output !== "string")
    )
      throw invalid("Некорректный формат тестов");
    if (test.output === null && tests.length > 1)
      throw invalid("Запуск без проверки возможен только с одним тестом");
    if (
      test.input.length > LIMITS.testText ||
      (typeof test.output === "string" && test.output.length > LIMITS.testText)
    )
      throw invalid("Тест слишком большой");
  }
}

/**
 * Judge0 id of the newest installed version of a language, or null.
 * @param {unknown} languages response of Judge0 `GET /languages`
 * @param {string} language
 */
export function pickLanguageId(languages, language) {
  if (!Array.isArray(languages) || !Object.hasOwn(LANGUAGE_PATTERNS, language)) return null;
  const pattern = LANGUAGE_PATTERNS[/** @type {Language} */ (language)];
  let best = null;
  for (const item of /** @type {Judge0Language[]} */ (languages)) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || !pattern.test(String(item?.name ?? ""))) continue;
    if (best === null || id > best) best = id;
  }
  return best;
}

const text = (/** @type {unknown} */ value) => (typeof value === "string" ? value : "");

/**
 * Maps a Judge0 submission result to what the runner does next.
 * Status ids: 1–2 queued/processing, 3 accepted, 4 wrong answer (the program ran; the runner
 * compares the output itself), 5 time limit, 6 compilation error, 7–12 runtime errors,
 * 13 internal error, 14 exec format error.
 * @param {Judge0Result | null | undefined} result
 * @returns {JudgeOutcome}
 */
export function judgeOutcome(result) {
  const id = Number(result?.status?.id);
  const description = text(result?.status?.description);
  if (id === 1 || id === 2) return { kind: "pending" };
  if (id === 3 || id === 4)
    return { kind: "completed", stdout: text(result?.stdout).slice(0, LIMITS.stdout) };
  if (id === 5) return { kind: "failed", output: MESSAGES.timeout };
  if (id === 6) {
    const details = text(result?.compile_output) || text(result?.message) || description;
    return { kind: "failed", output: (MESSAGES.compile + details).slice(0, LIMITS.output) };
  }
  if (id >= 7 && id <= 12) {
    const details = text(result?.stderr) || description || MESSAGES.runtimeFallback;
    return {
      kind: "failed",
      output: (MESSAGES.runtime + details).slice(0, LIMITS.output),
      runtime: true,
    };
  }
  return {
    kind: "unavailable",
    detail:
      `Judge0 status ${Number.isFinite(id) ? id : "unknown"} ${description} ${text(result?.message)}`.trim(),
  };
}

/** @type {Omit<RunnerConfig, "fetch" | "log">} */
const DEFAULTS = {
  judge0Url: "",
  runnerToken: "",
  judge0Token: "",
  maxConcurrent: 4,
  requestLimit: 1_000_000,
  pollIntervalMs: 300,
  pollTimeoutMs: 20_000,
  submissionTimeoutMs: 45_000,
};

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a runner instance: an HTTP server plus the functions behind it.
 * @param {Partial<RunnerConfig>} [options]
 */
export function createRunner(options = {}) {
  /** @type {RunnerConfig} */
  const config = {
    ...DEFAULTS,
    fetch: globalThis.fetch,
    log: console.error,
    ...options,
  };
  const judge0Url = config.judge0Url.replace(/\/+$/, "");
  const judgeHeaders = {
    "Content-Type": "application/json",
    ...(config.judge0Token ? { "X-Auth-Token": config.judge0Token } : {}),
  };
  /** @type {unknown[] | null} successful `/languages` response; failures are never cached */
  let languagesCache = null;
  let active = 0;

  /**
   * @param {string} pathname
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function judge(pathname, body) {
    if (!judge0Url) throw judgeUnavailable("JUDGE0_URL is not configured");
    let response;
    try {
      response = await config.fetch(judge0Url + pathname, {
        method: body === undefined ? "GET" : "POST",
        headers: judgeHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.submissionTimeoutMs),
      });
    } catch (error) {
      throw judgeUnavailable(`Judge0 request ${pathname} failed: ${String(error)}`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = payload?.message || payload?.error || "";
      throw judgeUnavailable(
        `Judge0 ${pathname} answered HTTP ${response.status} ${reason}`.trim(),
      );
    }
    return payload;
  }

  /** Fetches the installed languages and caches them on success. */
  async function loadLanguages() {
    const list = await judge("/languages");
    if (!Array.isArray(list)) throw judgeUnavailable("Judge0 /languages did not return an array");
    languagesCache = list;
    return list;
  }

  /** @param {Language} language */
  async function languageIdFor(language) {
    let id = languagesCache ? pickLanguageId(languagesCache, language) : null;
    // The language may have been installed after the cache was filled: refresh once.
    if (id === null) id = pickLanguageId(await loadLanguages(), language);
    if (id === null)
      throw new RunnerError(
        503,
        "LANGUAGE_UNAVAILABLE",
        MESSAGES.languageUnavailable,
        `Judge0 has no language matching ${language}`,
      );
    return id;
  }

  /**
   * Submits one test and polls until Judge0 has a result.
   * @param {string} code
   * @param {number} languageId
   * @param {string} input
   * @returns {Promise<Exclude<JudgeOutcome, { kind: "pending" | "unavailable" }>>}
   */
  async function runTest(code, languageId, input) {
    const submission = await judge("/submissions?base64_encoded=false&wait=false", {
      source_code: code,
      language_id: languageId,
      stdin: input,
      cpu_time_limit: 2,
      wall_time_limit: 5,
      memory_limit: 262_144,
      enable_network: false,
      max_file_size: 1_024,
    });
    if (typeof submission?.token !== "string" || !submission.token)
      throw judgeUnavailable("Judge0 did not return a submission token");
    const resultPath =
      `/submissions/${encodeURIComponent(submission.token)}` +
      "?base64_encoded=false&fields=status,stdout,stderr,compile_output,message";
    const deadline = Date.now() + config.pollTimeoutMs;
    for (;;) {
      await sleep(config.pollIntervalMs);
      const outcome = judgeOutcome(await judge(resultPath));
      if (outcome.kind === "unavailable") throw judgeUnavailable(outcome.detail);
      if (outcome.kind !== "pending") return outcome;
      if (Date.now() >= deadline) return { kind: "failed", output: MESSAGES.timeout };
    }
  }

  /**
   * Runs the code against every test. A practice run (one test with `output: null`) returns the
   * program output instead of comparing it.
   * @param {unknown} body
   * @returns {Promise<ExecutionResult>}
   */
  async function execute(body) {
    validateExecution(body);
    const languageId = await languageIdFor(body.language);
    const practice = body.tests.length === 1 && body.tests[0].output === null;
    let passed = 0;
    let output = "";
    let correct = true;
    for (const [index, test] of body.tests.entries()) {
      const outcome = await runTest(body.code, languageId, test.input);
      if (outcome.kind === "failed") {
        correct = false;
        // stderr of a hidden test may echo its input (the program can print stdin and crash), so
        // runtime details are shown only for the first test (the task's public example) and for
        // practice runs with the child's own input.
        output =
          outcome.runtime && !practice && index > 0
            ? `${MESSAGES.runtime}${MESSAGES.runtimeFallback} на тесте ${index + 1}`
            : outcome.output;
        break;
      }
      if (practice) {
        passed += 1;
        output = outcome.stdout.slice(0, LIMITS.output);
      } else if (normalizeOutput(outcome.stdout) === normalizeOutput(test.output)) {
        passed += 1;
      } else {
        correct = false;
      }
    }
    if (!practice && !output) output = `Пройдено тестов: ${passed} из ${body.tests.length}`;
    return { correct, output, passed, total: body.tests.length };
  }

  /** @returns {Promise<{ status: number; body: Record<string, unknown> }>} */
  async function health() {
    if (!judge0Url) return { status: 200, body: { status: "degraded", judge0: "not_configured" } };
    try {
      const list = await loadLanguages();
      return { status: 200, body: { status: "ok", judge0: "ok", languages: list.length } };
    } catch (error) {
      config.log(
        "[runner] health check failed:",
        error instanceof RunnerError ? error.detail : error,
      );
      return { status: 503, body: { status: "degraded", judge0: "unavailable" } };
    }
  }

  /** @param {http.IncomingMessage} req */
  function authorized(req) {
    // Local Docker keeps the runner on the internal network and may omit the token.
    // Production requires RUNNER_TOKEN (checked by scripts/docker-start.mjs of the web app).
    if (!config.runnerToken) return true;
    const actual = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${config.runnerToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {Promise<unknown>}
   */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const tooLarge = () => new RunnerError(413, "PAYLOAD_TOO_LARGE", MESSAGES.tooLarge);
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > config.requestLimit) {
        req.resume();
        reject(tooLarge());
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      let settled = false;
      req.on("data", (/** @type {Buffer} */ chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > config.requestLimit) {
          settled = true;
          reject(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          reject(new RunnerError(400, "BAD_REQUEST", MESSAGES.badJson));
        }
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {unknown} data
   * @param {Record<string, string>} [extraHeaders]
   */
  function send(res, status, data, extraHeaders = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    });
    res.end(JSON.stringify(data));
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [extraHeaders]
   */
  function sendError(res, status, code, message, extraHeaders) {
    send(res, status, { error: { code, message } }, extraHeaders);
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    const pathname = new URL(req.url ?? "/", "http://runner").pathname;
    try {
      if (pathname === "/health" && req.method === "GET") {
        const result = await health();
        return send(res, result.status, result.body);
      }
      if (!authorized(req)) return sendError(res, 401, "UNAUTHORIZED", MESSAGES.unauthorized);
      if (pathname !== "/execute" || req.method !== "POST")
        return sendError(res, 404, "NOT_FOUND", MESSAGES.notFound);
      if (active >= config.maxConcurrent)
        return sendError(res, 429, "RUNNER_BUSY", MESSAGES.busy, { "Retry-After": "2" });
      active += 1;
      try {
        const body = await readJson(req);
        return send(res, 200, await execute(body));
      } finally {
        active -= 1;
      }
    } catch (error) {
      if (error instanceof RunnerError) {
        if (error.detail) config.log(`[runner] ${error.code}: ${oneLine(error.detail)}`);
        return sendError(
          res,
          error.status,
          error.code,
          error.message,
          error.status === 413 ? { Connection: "close" } : {},
        );
      }
      config.log("[runner] unexpected error:", error);
      return sendError(res, 500, "RUNNER_ERROR", MESSAGES.internal);
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    handle,
    execute,
    health,
    /** Number of /execute requests in progress. */
    get active() {
      return active;
    },
  };
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const { port, ...config } = configFromEnv();
  const runner = createRunner(config);
  runner.server.listen(port, "0.0.0.0", () => {
    console.log(`Olympus runner listening on :${port}`);
    if (!config.judge0Url) console.warn("[runner] JUDGE0_URL is not set: /execute will answer 503");
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => runner.server.close(() => process.exit(0)));
}
