// Technical `test_user` account of the public evaluator API (/api/v1).
import { ApiError, unauthorized } from "@/lib/server/errors";
import type { ServerEnv } from "@/lib/server/env";
import { bearerToken } from "@/lib/server/http";
import { sha256Hex, timingSafeEqual } from "@/lib/server/crypto";
import type { Actor } from "./context";

export const TEST_USER_ID = "test:evaluator";
export const TEST_USER_ROLE = "test_user";

export interface TestLogin {
  accessToken: string;
  tokenType: "Bearer";
  role: typeof TEST_USER_ROLE;
  userId: typeof TEST_USER_ID;
}

function account(env: Pick<ServerEnv, "TEST_API_USERNAME" | "TEST_API_PASSWORD">) {
  const username = env.TEST_API_USERNAME || "test_user";
  const password = env.TEST_API_PASSWORD;
  if (!password)
    throw new ApiError(
      503,
      "TEST_ACCOUNT_NOT_CONFIGURED",
      "Тестовая учётная запись API не настроена",
    );
  return { username, password };
}

/** Deterministic token: stays valid across restarts and changes when the password changes. */
async function accountToken(username: string, password: string): Promise<string> {
  return sha256Hex(`olympus-test:${username}:${password}`);
}

export async function loginTestUser(
  env: Pick<ServerEnv, "TEST_API_USERNAME" | "TEST_API_PASSWORD">,
  username: string,
  password: string,
): Promise<TestLogin> {
  const expected = account(env);
  const [userOk, passwordOk] = await Promise.all([
    timingSafeEqual(username, expected.username),
    timingSafeEqual(password, expected.password),
  ]);
  if (!userOk || !passwordOk)
    throw unauthorized("Неверный логин или пароль тестовой учётной записи", "INVALID_CREDENTIALS");
  return {
    accessToken: await accountToken(expected.username, expected.password),
    tokenType: "Bearer",
    role: TEST_USER_ROLE,
    userId: TEST_USER_ID,
  };
}

export async function requireTestUser(
  env: Pick<ServerEnv, "TEST_API_USERNAME" | "TEST_API_PASSWORD">,
  req: Request,
): Promise<Actor> {
  const expected = account(env);
  const token = bearerToken(req);
  if (!token) throw unauthorized("Нужен Bearer-токен тестовой учётной записи", "UNAUTHORIZED");
  if (!(await timingSafeEqual(token, await accountToken(expected.username, expected.password))))
    throw unauthorized("Неверный токен тестовой учётной записи", "UNAUTHORIZED");
  return { userId: TEST_USER_ID, admin: false };
}
