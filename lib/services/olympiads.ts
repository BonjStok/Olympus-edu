import type { Olympiad, RegistrationProgress } from "@/lib/domain/types";
import type { Db } from "@/lib/server/db";
import { requireRecord } from "./content";
import type { Actor, ServiceContext } from "./context";
import { deleteProgress, progressKey, saveProgress } from "./progress";

/** Sets or removes the "I registered" mark of a published olympiad (`registration:<id>`). */
export async function setRegistration(
  ctx: ServiceContext,
  olympiadId: string,
  registered: boolean,
): Promise<boolean> {
  const olympiad = await requireRecord(ctx.db, olympiadId, "olympiads", ctx.actor);
  const key = progressKey.registration(olympiad.id);
  if (registered) {
    const value: RegistrationProgress = { registered: true };
    await saveProgress(ctx.db, ctx.actor.userId, key, value, ctx.now);
  } else {
    await deleteProgress(ctx.db, ctx.actor.userId, key);
  }
  return registered;
}

/**
 * Complete olympiad for its details screen: the catalogue leaves out `description`, `source`,
 * `verifiedAt` and `image`. Children get published olympiads only (404 `OLYMPIAD_NOT_FOUND` for
 * drafts, deleted and unknown ids).
 */
export function getOlympiad(db: Db, id: string, actor: Pick<Actor, "admin">): Promise<Olympiad> {
  return requireRecord(db, id, "olympiads", actor);
}
