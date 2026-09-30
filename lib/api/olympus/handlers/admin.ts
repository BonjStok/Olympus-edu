import {
  deleteRecord,
  listDeleted,
  publishRecords,
  recordHistory,
  restoreRevision,
  saveDraft,
} from "@/lib/services/admin";
import { uploadMedia } from "@/lib/services/media";
import { LARGE_BODY_LIMIT } from "@/lib/server/http";
import { requireId } from "@/lib/server/validate";
import { reply, serviceContext, type RpcRoutes } from "../context";

export const adminRoutes = {
  history: {
    access: "admin",
    async handle(ctx) {
      return reply({ history: await recordHistory(serviceContext(ctx), requireId(ctx.body.id)) });
    },
  },

  restore: {
    access: "admin",
    async handle(ctx) {
      await restoreRevision(serviceContext(ctx), requireId(ctx.body.revisionId, "revisionId"));
      return reply({ ok: true as const });
    },
  },

  delete: {
    access: "admin",
    async handle(ctx) {
      await deleteRecord(serviceContext(ctx), requireId(ctx.body.id));
      return reply({ ok: true as const });
    },
  },

  deleted: {
    access: "admin",
    async handle(ctx) {
      return reply({ deleted: await listDeleted(serviceContext(ctx)) });
    },
  },

  draft: {
    access: "admin",
    maxBody: LARGE_BODY_LIMIT,
    async handle(ctx) {
      const count = await saveDraft(serviceContext(ctx), ctx.body.record);
      return reply({ ok: true as const, count });
    },
  },

  publish: {
    access: "admin",
    maxBody: LARGE_BODY_LIMIT,
    async handle(ctx) {
      const count = await publishRecords(serviceContext(ctx), [ctx.body.record]);
      return reply({ ok: true as const, count });
    },
  },

  import: {
    access: "admin",
    maxBody: LARGE_BODY_LIMIT,
    async handle(ctx) {
      const count = await publishRecords(serviceContext(ctx), ctx.body.records);
      return reply({ ok: true as const, count });
    },
  },

  upload: {
    access: "admin",
    maxBody: LARGE_BODY_LIMIT,
    async handle(ctx) {
      return reply(await uploadMedia(ctx.env, ctx.body, ctx.now));
    },
  },
} satisfies Pick<
  RpcRoutes,
  "history" | "restore" | "delete" | "deleted" | "draft" | "publish" | "import" | "upload"
>;
