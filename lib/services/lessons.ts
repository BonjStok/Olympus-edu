import type { LessonProgress } from "@/lib/domain/types";
import { requireRecord } from "./content";
import type { ServiceContext } from "./context";
import { progressKey, saveProgress } from "./progress";

/** Marks a published lesson as read (`lesson:<id>`). */
export async function viewLesson(ctx: ServiceContext, lessonId: string): Promise<void> {
  const lesson = await requireRecord(ctx.db, lessonId, "lessons", ctx.actor);
  const value: LessonProgress = { read: true };
  await saveProgress(ctx.db, ctx.actor.userId, progressKey.lesson(lesson.id), value, ctx.now);
}
