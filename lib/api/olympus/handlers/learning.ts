import { getTopicContent } from "@/lib/services/content";
import { viewLesson } from "@/lib/services/lessons";
import { getOlympiad, setRegistration } from "@/lib/services/olympiads";
import { saveSettings } from "@/lib/services/settings";
import { awardTheoryStar } from "@/lib/services/stars";
import { unprocessable } from "@/lib/server/errors";
import { requireId } from "@/lib/server/validate";
import { reply, serviceContext, type RpcRoutes } from "../context";

export const learningRoutes = {
  "topic-content": {
    access: "session",
    async handle(ctx) {
      const { lessons, tasks } = await getTopicContent(
        ctx.db,
        requireId(ctx.body.id),
        serviceContext(ctx).actor,
      );
      return reply({ lessons, tasks });
    },
  },

  "view-lesson": {
    access: "session",
    async handle(ctx) {
      await viewLesson(serviceContext(ctx), requireId(ctx.body.id));
      return reply({ ok: true as const });
    },
  },

  /** Theory star of a topic (all its lessons were opened). */
  star: {
    access: "session",
    async handle(ctx) {
      await awardTheoryStar(serviceContext(ctx), requireId(ctx.body.id));
      return reply({ ok: true as const });
    },
  },

  olympiad: {
    access: "session",
    async handle(ctx) {
      const olympiad = await getOlympiad(ctx.db, requireId(ctx.body.id), serviceContext(ctx).actor);
      return reply({ olympiad });
    },
  },

  register: {
    access: "session",
    async handle(ctx) {
      if (typeof ctx.body.yes !== "boolean")
        throw unprocessable("Передайте yes: true или false", "INVALID_REGISTERED");
      const registered = await setRegistration(
        serviceContext(ctx),
        requireId(ctx.body.id),
        ctx.body.yes,
      );
      return reply({ ok: true as const, registered });
    },
  },

  settings: {
    access: "session",
    async handle(ctx) {
      const { action: _action, ...input } = ctx.body;
      const settings = await saveSettings(serviceContext(ctx), input);
      return reply({ ok: true as const, settings });
    },
  },
} satisfies Pick<
  RpcRoutes,
  "topic-content" | "view-lesson" | "star" | "olympiad" | "register" | "settings"
>;
