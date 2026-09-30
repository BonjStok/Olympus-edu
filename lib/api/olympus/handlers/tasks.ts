import { checkTask, hintTask, revealTask, runTask, saveCodeDraft } from "@/lib/services/tasks";
import { requireId } from "@/lib/server/validate";
import { reply, serviceContext, type RpcRoutes } from "../context";

export const taskRoutes = {
  check: {
    access: "session",
    async handle(ctx) {
      return reply(await checkTask(serviceContext(ctx), requireId(ctx.body.id), ctx.body));
    },
  },

  run: {
    access: "session",
    async handle(ctx) {
      return reply(await runTask(serviceContext(ctx), requireId(ctx.body.id), ctx.body));
    },
  },

  hint: {
    access: "session",
    async handle(ctx) {
      return reply(await hintTask(serviceContext(ctx), requireId(ctx.body.id)));
    },
  },

  reveal: {
    access: "session",
    async handle(ctx) {
      return reply(await revealTask(serviceContext(ctx), requireId(ctx.body.id)));
    },
  },

  "code-draft": {
    access: "session",
    async handle(ctx) {
      await saveCodeDraft(serviceContext(ctx), requireId(ctx.body.id), ctx.body);
      return reply({ ok: true as const });
    },
  },
} satisfies Pick<RpcRoutes, "check" | "run" | "hint" | "reveal" | "code-draft">;
