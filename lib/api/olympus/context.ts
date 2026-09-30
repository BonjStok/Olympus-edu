import type { OlympusAction, OlympusRpc } from "@/lib/domain/types";
import type { Db } from "@/lib/server/db";
import type { ServerEnv } from "@/lib/server/env";
import { sessionCookie, type Session } from "@/lib/server/session";
import type { ServiceContext } from "@/lib/services/context";

/** Per-request state handed to every RPC handler. */
export interface RpcContext {
  req: Request;
  db: Db;
  env: ServerEnv;
  now: number;
  /** The request reached us over HTTPS (directly or via the reverse proxy). */
  secure: boolean;
  session: Session | null;
  /** Parsed JSON body (already known to be an object). */
  body: Record<string, unknown>;
}

export type AuthedRpcContext = RpcContext & { session: Session };

export interface RpcReply<T> {
  data: T;
  headers?: Record<string, string>;
}

type Handler<A extends OlympusAction, C> = (ctx: C) => Promise<RpcReply<OlympusRpc[A]["res"]>>;

/**
 * - `public`: works without a session (the handler may create one);
 * - `session`: any guest/MAX session, 401 without it;
 * - `admin`: 401 without a session, 403 for non-admins.
 * `maxBody` raises the JSON size limit (default 256 KB) for actions that carry mock answers or
 * admin imports/uploads.
 */
export type RpcRoute<A extends OlympusAction> =
  | { access: "public"; maxBody?: undefined; handle: Handler<A, RpcContext> }
  | { access: "session" | "admin"; maxBody?: number; handle: Handler<A, AuthedRpcContext> };

export type RpcRoutes = { [A in OlympusAction]: RpcRoute<A> };

export function reply<T>(data: T, headers?: Record<string, string>): RpcReply<T> {
  return headers ? { data, headers } : { data };
}

export function serviceContext(ctx: AuthedRpcContext): ServiceContext {
  return {
    db: ctx.db,
    env: ctx.env,
    now: ctx.now,
    actor: { userId: ctx.session.userId, admin: ctx.session.admin },
  };
}

export function cookieHeaders(
  ctx: Pick<RpcContext, "now" | "secure">,
  session: Session,
): Record<string, string> {
  return { "Set-Cookie": sessionCookie(session.token, session.expires, ctx.now, ctx.secure) };
}
