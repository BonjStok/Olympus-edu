// Shared plumbing of the public evaluator API `/api/v1/*` (contract: openapi.yaml).
import { withDatabase, type Db } from "@/lib/server/db";
import { getEnv, type ServerEnv } from "@/lib/server/env";
import { ApiError, toApiError, v1ErrorBody } from "@/lib/server/errors";
import { jsonResponse } from "@/lib/server/http";
import type { Actor, ServiceContext } from "@/lib/services/context";
import { requireTestUser } from "@/lib/services/test-account";

export interface V1Context {
  req: Request;
  env: ServerEnv;
  now: number;
  params: Record<string, string>;
}

export interface V1AuthedContext extends V1Context {
  db: Db;
  actor: Actor;
  service: ServiceContext;
}

export interface V1Result {
  body: unknown;
  status?: number;
}

type RouteContext = { params?: Promise<Record<string, string | string[]>> };
export type RouteHandler = (req: Request, context?: RouteContext) => Promise<Response>;

async function readParams(context?: RouteContext): Promise<Record<string, string>> {
  const raw = (await context?.params) ?? {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join("/") : value,
    ]),
  );
}

export function v1ErrorResponse(error: unknown): Response {
  const apiError = toApiError(error);
  return jsonResponse(v1ErrorBody(apiError), apiError.status, apiError.headers);
}

/** Endpoint without the test-user token (health, login). */
export function publicRoute(handler: (ctx: V1Context) => Promise<V1Result>): RouteHandler {
  return async (req, context) => {
    try {
      const ctx: V1Context = {
        req,
        env: getEnv(),
        now: Date.now(),
        params: await readParams(context),
      };
      const result = await handler(ctx);
      return jsonResponse(result.body, result.status ?? 200);
    } catch (error) {
      return v1ErrorResponse(error);
    }
  };
}

/** Endpoint for the `test_user` account: Bearer token first, then one DB connection. */
export function testUserRoute(handler: (ctx: V1AuthedContext) => Promise<V1Result>): RouteHandler {
  return publicRoute(async (ctx) => {
    const actor = await requireTestUser(ctx.env, ctx.req);
    return withDatabase(ctx.env, (db) =>
      handler({ ...ctx, db, actor, service: { db, env: ctx.env, actor, now: ctx.now } }),
    );
  });
}

/** JSON 405 for HTTP methods an existing endpoint does not support (instead of an empty body). */
export function methodNotAllowed(allowed: readonly string[]): RouteHandler {
  const allow = allowed.join(", ");
  return async () =>
    v1ErrorResponse(
      new ApiError(405, "METHOD_NOT_ALLOWED", `Этот метод API принимает только ${allow}`, {
        Allow: allow,
      }),
    );
}

/** JSON 404 for any unknown `/api/v1/*` path (instead of the HTML error page). */
export const unknownEndpoint: RouteHandler = async () =>
  v1ErrorResponse(
    new ApiError(404, "NOT_FOUND", "Такого метода API нет. Список методов – в openapi.yaml"),
  );
