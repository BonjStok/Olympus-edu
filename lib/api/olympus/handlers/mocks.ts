import type { MockAttempt, ReviewedTask } from "@/lib/domain/types";
import {
  finishMock,
  getAttempt,
  recheckMock,
  saveMockAnswers,
  setProofResult,
  startMock,
} from "@/lib/services/mocks";
import { MOCK_BODY_LIMIT } from "@/lib/server/http";
import { requireBoolean, requireId } from "@/lib/server/validate";
import { reply, serviceContext, type RpcRoutes } from "../context";

export const mockRoutes = {
  "start-mock": {
    access: "session",
    async handle(ctx) {
      return reply({ attempt: await startMock(serviceContext(ctx), requireId(ctx.body.id)) });
    },
  },

  "mock-get": {
    access: "session",
    async handle(ctx) {
      return reply({ attempt: await getAttempt(serviceContext(ctx), requireId(ctx.body.id)) });
    },
  },

  /** Autosave (answer patch). When the time is over the attempt is finished and returned. */
  "mock-save": {
    access: "session",
    maxBody: MOCK_BODY_LIMIT,
    async handle(ctx) {
      const service = serviceContext(ctx);
      const id = requireId(ctx.body.id);
      const outcome = await saveMockAnswers(service, id, ctx.body.answers);
      if (outcome.status === "saved") return reply({ ok: true as const });
      const attempt: MockAttempt<ReviewedTask> =
        outcome.status === "finished" ? outcome.attempt : await finishMock(service, id);
      return reply({ attempt });
    },
  },

  "finish-mock": {
    access: "session",
    maxBody: MOCK_BODY_LIMIT,
    async handle(ctx) {
      const answers = ctx.body.answers ?? undefined;
      return reply({
        attempt: await finishMock(serviceContext(ctx), requireId(ctx.body.id), answers),
      });
    },
  },

  "mock-recheck": {
    access: "session",
    async handle(ctx) {
      return reply({ attempt: await recheckMock(serviceContext(ctx), requireId(ctx.body.id)) });
    },
  },

  "mock-proof": {
    access: "session",
    async handle(ctx) {
      const attempt = await setProofResult(
        serviceContext(ctx),
        requireId(ctx.body.id),
        requireId(ctx.body.taskId, "taskId"),
        requireBoolean(ctx.body.correct, "INVALID_SELF_CHECK", "Передай correct: true или false"),
      );
      return reply({ attempt });
    },
  },
} satisfies Pick<
  RpcRoutes,
  "start-mock" | "mock-get" | "mock-save" | "finish-mock" | "mock-recheck" | "mock-proof"
>;
