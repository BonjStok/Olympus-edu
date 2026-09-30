// End-to-end check of the evaluator API (DATA-API.yaml) against a running stack.
//   API_BASE_URL=http://localhost:3000 TEST_API_PASSWORD=... pnpm test:api
//   API_BASE_URL=https://olympus-edu.ru TEST_API_PASSWORD=... pnpm test:api
// Ids and answers come from test-data.json (kept equal to DATA-API.yaml and the content by
// tests/unit/contracts/data-api.test.ts). When a topic, lesson or olympiad id is not published
// (e.g. after a calendar update) the script falls back to a record of the same kind from
// /api/v1/content and says so. The numeric answer must be accepted as correct, and a mock answered
// completely by test-data.json must get the full score.
// API_TEST_OLYMPIAD_ID=<id> checks registration with that olympiad instead (it must be published).
import fs from "node:fs";

const base = (process.env.API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const username = process.env.TEST_API_USERNAME || "test_user";
const password = process.env.TEST_API_PASSWORD;
if (!password) {
  console.error("Set TEST_API_PASSWORD before running pnpm test:api");
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync("test-data.json", "utf8"));
for (const field of ["topicId", "lessonId", "olympiadId", "mockId"])
  if (typeof data[field] !== "string" || !data[field]) {
    console.error(`test-data.json: ${field} is missing`);
    process.exit(2);
  }
if (!data.numericTask?.id || typeof data.numericTask.correctAnswer !== "string") {
  console.error("test-data.json: numericTask { id, correctAnswer } is missing");
  process.exit(2);
}
if (!data.mockAnswers || typeof data.mockAnswers !== "object") {
  console.error("test-data.json: mockAnswers is missing");
  process.exit(2);
}
const TIMEOUT_MS = 5_000;
let accessToken = "";
let step = 0;
const TOTAL_STEPS = 13;

class SmokeError extends Error {}

function log(message) {
  step += 1;
  console.log(`${String(step).padStart(2)}/${TOTAL_STEPS} ${message}`);
}

/**
 * @param {string} path
 * @param {{ method?: string; body?: unknown; auth?: boolean; expect?: number[] }} [options]
 */
async function request(path, { method = "GET", body, auth = true, expect = [200] } = {}) {
  const headers = { Accept: "application/json" };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SmokeError(`${method} ${path}: no response (${error.message})`);
  }
  const text = await response.text();
  if (!expect.includes(response.status))
    throw new SmokeError(`${method} ${path} -> ${response.status} (expected ${expect}): ${text}`);
  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("application/json"))
    throw new SmokeError(`${method} ${path}: Content-Type is "${type}", expected application/json`);
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    throw new SmokeError(`${method} ${path}: body is not JSON: ${text.slice(0, 200)}`);
  }
}

function requireFields(name, body, fields) {
  const missing = fields.filter((field) => !(body && field in body));
  if (missing.length) throw new SmokeError(`${name}: missing fields ${missing.join(", ")}`);
}

function check(condition, message) {
  if (!condition) throw new SmokeError(message);
}

async function waitForHealth() {
  const deadline = Date.now() + Number(process.env.API_WAIT_MS || 60_000);
  for (;;) {
    try {
      return await request("/api/v1/health", { auth: false });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

/**
 * A published record id: the one from test-data.json, or the first one of that kind. An id given
 * explicitly (environment) must exist: there is no fallback for it.
 */
function pickId(records, kind, preferred, predicate = () => true, strict = false) {
  const candidates = records.filter((record) => record.kind === kind && predicate(record));
  if (candidates.some((record) => record.id === preferred)) return preferred;
  check(!strict, `${kind} "${preferred}" is not published`);
  check(candidates.length > 0, `No published ${kind} records to test with`);
  console.log(`    note: ${kind} "${preferred}" is not published, using "${candidates[0].id}"`);
  return candidates[0].id;
}

async function main() {
  log("health");
  const health = await waitForHealth();
  requireFields("health", health.body, ["status", "database", "version"]);
  check(health.body.status === "ok", `health status is ${health.body.status}`);

  log("login");
  const login = await request("/api/v1/auth/login", {
    method: "POST",
    auth: false,
    body: { username, password },
  });
  requireFields("login", login.body, ["accessToken", "tokenType", "role", "userId"]);
  accessToken = login.body.accessToken;

  log("authorization is enforced");
  const saved = accessToken;
  accessToken = "";
  const denied = await request("/api/v1/profile", { expect: [401] });
  check(denied.body?.error?.code, "401 response has no error.code");
  accessToken = saved;

  log("reset");
  requireFields("reset", (await request("/api/v1/test/reset", { method: "POST" })).body, [
    "ok",
    "userId",
    "reset",
  ]);

  log("content");
  const content = (await request("/api/v1/content")).body;
  requireFields("content", content, ["records", "count"]);
  check(Array.isArray(content.records) && content.count === content.records.length, "bad count");
  check(content.count > 0, "Content catalogue is empty");

  const topicId = pickId(content.records, "topics", data.topicId);
  log(`topic ${topicId}`);
  const topic = (await request(`/api/v1/topics/${topicId}`)).body;
  requireFields("topic", topic, ["topic", "lessons", "tasks"]);
  check(topic.lessons.length && topic.tasks.length, "Topic response is incomplete");
  for (const task of topic.tasks)
    check(!("answer" in task) && !("tests" in task), "Topic leaks answers or hidden tests");

  const lessonId = pickId(content.records, "lessons", data.lessonId);
  log(`lesson progress ${lessonId}`);
  requireFields(
    "lesson view",
    (await request(`/api/v1/lessons/${lessonId}/view`, { method: "POST" })).body,
    ["ok", "lessonId", "completed"],
  );

  log(`task check ${data.numericTask.id}`);
  const checked = (
    await request(`/api/v1/tasks/${data.numericTask.id}/check`, {
      method: "POST",
      body: { answer: data.numericTask.correctAnswer },
    })
  ).body;
  requireFields("check", checked, ["taskId", "correct", "practiceStar"]);
  check(checked.taskId === data.numericTask.id, `check answered for task ${checked.taskId}`);
  check(
    checked.correct === true,
    `Answer "${data.numericTask.correctAnswer}" of ${data.numericTask.id} was not accepted as correct`,
  );

  const olympiadOverride = (process.env.API_TEST_OLYMPIAD_ID || "").trim();
  const olympiadId = pickId(
    content.records,
    "olympiads",
    olympiadOverride || data.olympiadId,
    undefined,
    Boolean(olympiadOverride),
  );
  log(`olympiad registration ${olympiadId}`);
  const registered = (
    await request(`/api/v1/olympiads/${olympiadId}/register`, {
      method: "POST",
      body: { registered: true },
    })
  ).body;
  requireFields("register", registered, ["ok", "olympiadId", "registered"]);

  log(`mock start/save ${data.mockId}`);
  const started = await request(`/api/v1/mocks/${data.mockId}/start`, {
    method: "POST",
    expect: [201],
  });
  const attemptId = started.body.attempt?.id;
  check(attemptId, "Mock attempt id is missing");
  const attemptTasks = new Set(started.body.attempt.tasks.map((task) => task.id));
  const answers = Object.fromEntries(
    Object.entries(data.mockAnswers).filter(([taskId]) => attemptTasks.has(taskId)),
  );
  const unknown = Object.keys(data.mockAnswers).filter((taskId) => !attemptTasks.has(taskId));
  if (unknown.length)
    console.log(`    note: ${unknown.length} answers of test-data.json are not in this attempt`);
  const complete = [...attemptTasks].every((taskId) => taskId in answers);
  requireFields(
    "save",
    (
      await request(`/api/v1/mock-attempts/${attemptId}`, {
        method: "PATCH",
        body: { answers },
      })
    ).body,
    ["ok", "attemptId", "saved"],
  );

  log("mock finish");
  const finished = (
    await request(`/api/v1/mock-attempts/${attemptId}/finish`, {
      method: "POST",
      body: { answers },
    })
  ).body;
  requireFields("finish", finished, ["attempt"]);
  check(finished.attempt.finished === true, "Mock was not finished");
  for (const task of finished.attempt.tasks || [])
    check(!("tests" in task), "Hidden code tests leaked to API");
  const { score, max, pending } = finished.attempt;
  if (complete) {
    check(max > 0, "Finished mock has no points");
    check(pending === 0, `${pending} answers of the mock are still unchecked`);
    check(score === max, `Mock score is ${score} of ${max} with the answers of test-data.json`);
  } else {
    console.log(`    note: test-data.json does not answer every task, score ${score}/${max}`);
  }

  log("profile");
  const profile = (await request("/api/v1/profile")).body;
  requireFields("profile", profile, ["user", "progress", "updatedAt"]);
  check(profile.progress?.[`lesson:${lessonId}`], "Lesson progress was not persisted");
  check(profile.progress?.[`registration:${olympiadId}`], "Registration was not persisted");

  log("repeatability and cleanup");
  await request(`/api/v1/lessons/${lessonId}/view`, { method: "POST" });
  await request("/api/v1/test/reset", { method: "POST" });
  const empty = (await request("/api/v1/profile")).body;
  check(Object.keys(empty.progress).length === 0, "Reset did not clear the progress");
  console.log("Olympus API smoke test: OK");
}

main().catch((error) => {
  console.error(`Olympus API smoke test FAILED: ${error.message}`);
  process.exit(1);
});
