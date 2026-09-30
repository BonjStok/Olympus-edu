import { clientIp } from "@/lib/server/http";
import { createGuestSession, setSessionAdmin } from "@/lib/server/session";
import { adminLogin, signInWithMax } from "@/lib/services/auth";
import { cookieHeaders, reply, type RpcRoutes } from "../context";

export const sessionRoutes = {
  /**
   * Without `initData`: returns the current session or starts a guest one.
   * With `initData`: verifies the MAX launch data and switches to the MAX account.
   */
  session: {
    access: "public",
    async handle(ctx) {
      const initData = ctx.body.initData;
      if (initData !== undefined && initData !== null && initData !== "") {
        const { session, startParam } = await signInWithMax(
          ctx.db,
          ctx.env,
          ctx.session,
          initData,
          ctx.now,
        );
        return reply(
          startParam
            ? { ok: true as const, sessionToken: session.token, startParam }
            : { ok: true as const, sessionToken: session.token },
          cookieHeaders(ctx, session),
        );
      }
      if (ctx.session) return reply({ ok: true as const, sessionToken: ctx.session.token });
      const session = await createGuestSession(ctx.db, ctx.now);
      return reply({ ok: true as const, sessionToken: session.token }, cookieHeaders(ctx, session));
    },
  },

  "admin-login": {
    access: "session",
    async handle(ctx) {
      const session = await adminLogin(
        ctx.db,
        ctx.env,
        ctx.session,
        ctx.body.password,
        clientIp(ctx.req),
        ctx.now,
      );
      return reply({ ok: true as const, sessionToken: session.token }, cookieHeaders(ctx, session));
    },
  },

  "admin-logout": {
    access: "session",
    async handle(ctx) {
      await setSessionAdmin(ctx.db, ctx.session.key, false, ctx.now);
      return reply({ ok: true as const });
    },
  },
} satisfies Pick<RpcRoutes, "session" | "admin-login" | "admin-logout">;
