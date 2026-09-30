// `/api/olympus`: GET = bootstrap of the mini-app, POST = RPC `{ action, ...params }`.
// The contract (actions, payloads, errors) is described in lib/domain/types.ts.
import type { BootstrapResponse, OlympusAction } from "@/lib/domain/types";
import { withDatabase } from "@/lib/server/db";
import { features, getEnv, type ServerEnv } from "@/lib/server/env";
import {
  ApiError,
  badRequest,
  forbidden,
  rpcErrorBody,
  toApiError,
  unauthorized,
} from "@/lib/server/errors";
import {
  DEFAULT_BODY_LIMIT,
  isJsonContentType,
  isSameOrigin,
  isSecureRequest,
  jsonResponse,
  jsonTextResponse,
  LARGE_BODY_LIMIT,
  MOCK_BODY_LIMIT,
  readJsonBody,
} from "@/lib/server/http";
import {
  createGuestSession,
  isMaxUser,
  loadSession,
  usesHeaderAuth,
  type Session,
} from "@/lib/server/session";
import { isPlainObject } from "@/lib/server/validate";
import { catalogueJson } from "@/lib/services/catalogue";
import { listAdminRecords } from "@/lib/services/content";
import { listProgress, progressMap } from "@/lib/services/progress";
import {
  cookieHeaders,
  type AuthedRpcContext,
  type RpcContext,
  type RpcRoute,
  type RpcRoutes,
} from "./context";
import { adminRoutes } from "./handlers/admin";
import { learningRoutes } from "./handlers/learning";
import { mockRoutes } from "./handlers/mocks";
import { sessionRoutes } from "./handlers/session";
import { taskRoutes } from "./handlers/tasks";

export const routes: RpcRoutes = {
  ...sessionRoutes,
  ...learningRoutes,
  ...taskRoutes,
  ...mockRoutes,
  ...adminRoutes,
};

function isAction(value: unknown): value is OlympusAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(routes, value);
}

function errorResponse(error: unknown): Response {
  const apiError = toApiError(error);
  return jsonResponse(rpcErrorBody(apiError), apiError.status, apiError.headers);
}

/** Any other method: 405 in the usual error format. */
export function handleOlympusOtherMethod(): Response {
  return jsonResponse(
    rpcErrorBody(new ApiError(405, "METHOD_NOT_ALLOWED", "Используйте GET или POST")),
    405,
    { Allow: "GET, POST" },
  );
}

/**
 * Bootstrap body: the already serialised catalogue plus the per-user part. The catalogue (hundreds
 * of KB) is spliced in as is instead of being parsed and serialised again for every request.
 */
export function bootstrapJson(
  recordsJson: string,
  rest: Omit<BootstrapResponse, "records">,
): string {
  return `{"records":${recordsJson},${JSON.stringify(rest).slice(1)}`;
}

/** GET /api/olympus – catalogue, progress and profile; starts a guest session when needed. */
export async function handleOlympusGet(req: Request, env: ServerEnv = getEnv()): Promise<Response> {
  const now = Date.now();
  try {
    return await withDatabase(env, async (db) => {
      let session: Session | null = await loadSession(db, req, now);
      let headers: Record<string, string> = {};
      if (!session) {
        session = await createGuestSession(db, now);
        headers = cookieHeaders({ now, secure: isSecureRequest(req) }, session);
      }
      // Children share one cached catalogue; teachers get every record with its draft, uncached.
      const [records, progress] = await Promise.all([
        session.admin
          ? listAdminRecords(db).then((list) => JSON.stringify(list))
          : catalogueJson(db),
        listProgress(db, session.userId),
      ]);
      const flags = features(env);
      const rest: Omit<BootstrapResponse, "records"> = {
        progress: progressMap(progress),
        profile: {
          name: session.name,
          photo: null,
          max: isMaxUser(session.userId),
          admin: session.admin,
        },
        features: flags,
        sessionToken: session.token,
        serverTime: now,
        runner: flags.runner,
        maxConnected: flags.max,
      };
      return jsonTextResponse(bootstrapJson(records, rest), 200, headers);
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/olympus – `{ action, ...params }`. */
export async function handleOlympusPost(
  req: Request,
  env: ServerEnv = getEnv(),
): Promise<Response> {
  const now = Date.now();
  try {
    // Cookie-authenticated (or anonymous) browser requests must come from our own origin.
    // Requests with an Authorization header cannot be forged cross-site and skip this check.
    if (!usesHeaderAuth(req) && !isSameOrigin(req))
      throw forbidden("Запрос отклонён: недопустимый источник", "BAD_ORIGIN");
    if (!isJsonContentType(req))
      throw new ApiError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Используйте Content-Type: application/json",
      );

    return await withDatabase(env, async (db) => {
      const session = await loadSession(db, req, now);
      const { value, bytes } = await readJsonBody(req, {
        maxBytes: session?.admin ? LARGE_BODY_LIMIT : MOCK_BODY_LIMIT,
      });
      if (!isPlainObject(value)) throw badRequest("Тело запроса должно быть JSON-объектом");
      if (!isAction(value.action)) throw badRequest("Неизвестное действие", "UNKNOWN_ACTION");
      const route = routes[value.action] as RpcRoute<OlympusAction>;
      if (bytes > (route.maxBody ?? DEFAULT_BODY_LIMIT))
        throw new ApiError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Слишком большой запрос. Уменьшите размер данных",
        );

      const ctx: RpcContext = {
        req,
        db,
        env,
        now,
        secure: isSecureRequest(req),
        session,
        body: value,
      };
      let result;
      if (route.access === "public") {
        result = await route.handle(ctx);
      } else {
        if (!session)
          throw unauthorized(
            "Сеанс закончился. Обнови страницу, чтобы продолжить",
            "SESSION_EXPIRED",
          );
        if (route.access === "admin" && !session.admin)
          throw session.adminExpired
            ? forbidden(
                "Режим учителя закрылся после часа без действий. Войдите снова",
                "ADMIN_EXPIRED",
              )
            : forbidden("Требуется вход администратора", "ADMIN_REQUIRED");
        result = await route.handle(ctx as AuthedRpcContext);
      }
      return jsonResponse(result.data, 200, result.headers);
    });
  } catch (error) {
    return errorResponse(error);
  }
}
