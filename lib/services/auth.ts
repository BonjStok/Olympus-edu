// Sign-in flows of the mini-app: MAX identity and the admin password.
import { badRequest, forbidden, tooManyRequests, unavailable } from "@/lib/server/errors";
import type { Db } from "@/lib/server/db";
import type { ServerEnv } from "@/lib/server/env";
import { timingSafeEqual } from "@/lib/server/crypto";
import { verifyInitData, INIT_DATA_MAX_LENGTH } from "@/lib/server/max-auth";
import { LOGIN_RATE_LIMIT_MESSAGE, loginLimiter } from "@/lib/server/rate-limit";
import {
  createSession,
  deleteSession,
  isGuest,
  MAX_SESSION_TTL_MS,
  rotateSession,
  type Session,
} from "@/lib/server/session";
import { INPUT_LIMITS } from "@/lib/server/validate";
import { mergeUserProgress } from "./progress";

export interface MaxSignIn {
  session: Session;
  startParam: string | null;
}

/**
 * Exchanges signed MAX launch data for a `max:<id>` session. A guest session is merged into the MAX
 * account (progress and settings move over, the guest disappears); any other previous session
 * token is revoked.
 */
export async function signInWithMax(
  db: Db,
  env: Pick<ServerEnv, "BOT_TOKEN">,
  current: Session | null,
  initData: unknown,
  now: number,
): Promise<MaxSignIn> {
  if (!env.BOT_TOKEN)
    throw unavailable(
      "Вход через MAX пока не подключён: на сервере не задан токен бота",
      "MAX_NOT_CONFIGURED",
    );
  if (typeof initData !== "string" || initData.length > INIT_DATA_MAX_LENGTH)
    throw badRequest("initData должен быть строкой из MAX", "MAX_AUTH_FAILED");
  const verified = await verifyInitData(initData, env.BOT_TOKEN, now);
  const userId = `max:${verified.user.id}`;
  const session = await db.transaction(async (tx) => {
    if (current && isGuest(current.userId))
      await mergeUserProgress(tx, current.userId, userId, now);
    else if (current) await deleteSession(tx, current.key);
    return createSession(tx, {
      userId,
      name: verified.user.displayName,
      expires: now + MAX_SESSION_TTL_MS,
      now,
    });
  });
  return { session, startParam: verified.startParam };
}

/**
 * Admin password check with the shared login rate limiter. On success the session token is rotated
 * (a token observed before the login cannot be used as an admin token).
 */
export async function adminLogin(
  db: Db,
  env: Pick<ServerEnv, "ADMIN_PASSWORD">,
  session: Session,
  password: unknown,
  clientKey: string,
  now: number,
): Promise<Session> {
  const decision = loginLimiter.check(clientKey);
  if (!decision.allowed)
    throw tooManyRequests(LOGIN_RATE_LIMIT_MESSAGE, decision.retryAfterSeconds);
  if (!env.ADMIN_PASSWORD)
    throw unavailable("Вход администратора не настроен", "ADMIN_NOT_CONFIGURED");
  if (typeof password !== "string" || password.length > INPUT_LIMITS.password)
    throw badRequest("Введите пароль", "INVALID_REQUEST");
  if (!(await timingSafeEqual(password, env.ADMIN_PASSWORD))) {
    const after = loginLimiter.recordFailure(clientKey);
    if (!after.allowed) throw tooManyRequests(LOGIN_RATE_LIMIT_MESSAGE, after.retryAfterSeconds);
    throw forbidden("Неверный пароль", "WRONG_PASSWORD");
  }
  loginLimiter.reset(clientKey);
  return rotateSession(db, session, { admin: true }, now);
}
