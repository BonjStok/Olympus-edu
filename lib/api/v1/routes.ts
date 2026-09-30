// Endpoints of `/api/v1`. Each `app/api/v1/**/route.ts` re-exports one of these handlers.
import packageJson from "@/package.json";
import type { RecordKind } from "@/lib/domain/types";
import { withDatabase } from "@/lib/server/db";
import { ApiError, conflict, notFound, tooManyRequests, unprocessable } from "@/lib/server/errors";
import { clientIp, MOCK_BODY_LIMIT, readJsonBody } from "@/lib/server/http";
import { LOGIN_RATE_LIMIT_MESSAGE, loginLimiter } from "@/lib/server/rate-limit";
import { INPUT_LIMITS, isPlainObject, isValidId } from "@/lib/server/validate";
import { getTopicContent, listPublicSummaries, notFoundError } from "@/lib/services/content";
import { viewLesson } from "@/lib/services/lessons";
import { finishMock, saveMockAnswers, startMock } from "@/lib/services/mocks";
import { setRegistration } from "@/lib/services/olympiads";
import { listProgress, progressMap, resetProgress } from "@/lib/services/progress";
import { checkTask } from "@/lib/services/tasks";
import { loginTestUser, TEST_USER_ROLE } from "@/lib/services/test-account";
import { publicRoute, testUserRoute, type V1Context } from "./handler";

export const API_VERSION: string = packageJson.version;

/**
 * DATA-API.yaml sends a fixed answer map: answers to tasks that are not part of the attempt (for
 * example after the mock's task list changed) are ignored instead of failing the check.
 */
const LENIENT_ANSWERS = { mode: "lenient" } as const;

/** Path ids that cannot exist are reported as "not found" (openapi: 404). */
function pathId(ctx: V1Context, kind: RecordKind | "attempt"): string {
  const id = ctx.params.id ?? "";
  if (isValidId(id)) return id;
  throw kind === "attempt"
    ? notFound("Попытка не найдена", "ATTEMPT_NOT_FOUND")
    : notFoundError(kind);
}

async function jsonObject(
  ctx: V1Context,
  options: { optional?: boolean; maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const { value } = await readJsonBody(ctx.req, options);
  if (value === undefined) return {};
  if (!isPlainObject(value))
    throw new ApiError(400, "INVALID_JSON", "Тело запроса должно быть JSON-объектом");
  return value;
}

/** GET /api/v1/health – does not touch content; checks the database with `SELECT 1`. */
export const health = publicRoute(async (ctx) => {
  try {
    await withDatabase(ctx.env, (db) => db.one("SELECT 1 AS ok"));
    return { body: { status: "ok", database: "ok", version: API_VERSION } };
  } catch (error) {
    console.error("[olympus] health check failed:", error);
    return {
      status: 503,
      body: { status: "degraded", database: "unavailable", version: API_VERSION },
    };
  }
});

/** POST /api/v1/auth/login – shares the login rate limiter with the admin panel. */
export const login = publicRoute(async (ctx) => {
  const key = clientIp(ctx.req);
  const decision = loginLimiter.check(key);
  if (!decision.allowed)
    throw tooManyRequests(LOGIN_RATE_LIMIT_MESSAGE, decision.retryAfterSeconds);
  const body = await jsonObject(ctx);
  if (typeof body.username !== "string" || typeof body.password !== "string")
    throw unprocessable("Передайте строки username и password", "INVALID_CREDENTIALS_FORMAT");
  try {
    const result = await loginTestUser(
      ctx.env,
      body.username.slice(0, INPUT_LIMITS.username),
      body.password.slice(0, INPUT_LIMITS.password),
    );
    loginLimiter.reset(key);
    return { body: result };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const after = loginLimiter.recordFailure(key);
      if (!after.allowed) throw tooManyRequests(LOGIN_RATE_LIMIT_MESSAGE, after.retryAfterSeconds);
    }
    throw error;
  }
});

/** GET /api/v1/content */
export const content = testUserRoute(async ({ db }) => {
  const records = await listPublicSummaries(db);
  return { body: { records, count: records.length } };
});

/** GET /api/v1/topics/{id} */
export const topic = testUserRoute(async (ctx) => ({
  body: await getTopicContent(ctx.db, pathId(ctx, "topics"), ctx.actor),
}));

/** GET /api/v1/profile */
export const profile = testUserRoute(async ({ db, actor }) => {
  const entries = await listProgress(db, actor.userId);
  return {
    body: {
      user: { id: actor.userId, role: TEST_USER_ROLE },
      progress: progressMap(entries),
      updatedAt: entries.length ? Math.max(...entries.map((entry) => entry.updated)) : null,
    },
  };
});

/** POST /api/v1/lessons/{id}/view */
export const lessonView = testUserRoute(async (ctx) => {
  const id = pathId(ctx, "lessons");
  await viewLesson(ctx.service, id);
  return { body: { ok: true, lessonId: id, completed: true } };
});

/** POST /api/v1/tasks/{id}/check */
export const taskCheck = testUserRoute(async (ctx) => {
  const id = pathId(ctx, "tasks");
  const body = await jsonObject(ctx);
  return { body: { taskId: id, ...(await checkTask(ctx.service, id, body)) } };
});

/** POST /api/v1/olympiads/{id}/register */
export const olympiadRegister = testUserRoute(async (ctx) => {
  const id = pathId(ctx, "olympiads");
  const body = await jsonObject(ctx);
  if (typeof body.registered !== "boolean")
    throw unprocessable("registered должен быть boolean", "INVALID_REGISTERED");
  const registered = await setRegistration(ctx.service, id, body.registered);
  return { body: { ok: true, olympiadId: id, registered } };
});

/** POST /api/v1/mocks/{id}/start */
export const mockStart = testUserRoute(async (ctx) => ({
  status: 201,
  body: { attempt: await startMock(ctx.service, pathId(ctx, "mock-tests")) },
}));

/** PATCH /api/v1/mock-attempts/{id} – merges answers into a running attempt. */
export const mockSave = testUserRoute(async (ctx) => {
  const id = pathId(ctx, "attempt");
  const body = await jsonObject(ctx, { maxBytes: MOCK_BODY_LIMIT });
  const outcome = await saveMockAnswers(ctx.service, id, body.answers, LENIENT_ANSWERS);
  if (outcome.status === "finished") throw conflict("Пробник уже завершён", "ATTEMPT_FINISHED");
  if (outcome.status === "expired")
    throw conflict("Время пробника истекло: завершите попытку", "ATTEMPT_TIME_EXPIRED");
  return { body: { ok: true, attemptId: id, saved: true } };
});

/** POST /api/v1/mock-attempts/{id}/finish – body is optional. */
export const mockFinish = testUserRoute(async (ctx) => {
  const id = pathId(ctx, "attempt");
  const body = await jsonObject(ctx, { optional: true, maxBytes: MOCK_BODY_LIMIT });
  return {
    body: {
      attempt: await finishMock(ctx.service, id, body.answers ?? undefined, LENIENT_ANSWERS),
    },
  };
});

/** POST /api/v1/test/reset – clears progress of the technical account only. */
export const testReset = testUserRoute(async ({ db, actor }) => {
  await resetProgress(db, actor.userId);
  return { body: { ok: true, userId: actor.userId, reset: true } };
});
