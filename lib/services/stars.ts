import { countsAsSolved, PRACTICE_STAR_GOAL } from "@/lib/domain/achievements.mjs";
import type { StarProgress, Task, Topic } from "@/lib/domain/types";
import { parseJson } from "@/lib/server/db";
import { conflict } from "@/lib/server/errors";
import { findRecord, requireRecord, topicChildren } from "./content";
import type { ServiceContext } from "./context";
import { getProgress, progressKey, saveProgress } from "./progress";

/**
 * A practice star is earned once `PRACTICE_STAR_GOAL` tasks of a topic count as solved on the
 * child's own (`countsAsSolved`). Both rules live in lib/domain/achievements.mjs and are shared
 * with the mini-app and the chat-bot, so the star and the "tasks left" hint always agree.
 */
export function earnsPracticeStar(solvedInTopic: number, alreadyEarned: boolean): boolean {
  return !alreadyEarned && solvedInTopic >= PRACTICE_STAR_GOAL;
}

/** Lessons of a topic that the child has not opened yet. */
export function unreadLessons(
  lessonIds: readonly string[],
  readKeys: ReadonlySet<string>,
): string[] {
  return lessonIds.filter((id) => !readKeys.has(progressKey.lesson(id)));
}

function star(topic: Topic, type: StarProgress["type"], now: number): StarProgress {
  return { title: topic.title, subject: topic.subject, type, date: now };
}

/**
 * Theory star: every published lesson of the topic must be read. Idempotent – the first date is
 * kept when the star already exists (including the legacy `star:` key).
 */
export async function awardTheoryStar(ctx: ServiceContext, topicId: string): Promise<void> {
  const { db, actor, now } = ctx;
  const topic = await requireRecord(db, topicId, "topics", actor);
  const { lessons } = await topicChildren(db, topicId);
  if (!lessons.length) throw conflict("В теме пока нет уроков", "TOPIC_HAS_NO_LESSONS");
  const rows = await db.query<{ key: string }>(
    "SELECT key FROM progress WHERE user_id = $1 AND key LIKE 'lesson:%'",
    [actor.userId],
  );
  const unread = unreadLessons(
    lessons.map((lesson) => lesson.id),
    new Set(rows.map((row) => row.key)),
  );
  if (unread.length) throw conflict("Сначала открой все уроки темы", "LESSONS_NOT_READ");
  const existing =
    (await getProgress(db, actor.userId, progressKey.theoryStar(topicId))) ??
    (await getProgress(db, actor.userId, progressKey.legacyStar(topicId)));
  if (existing) return;
  await saveProgress(
    db,
    actor.userId,
    progressKey.theoryStar(topicId),
    star(topic, "theory", now),
    now,
  );
}

/** Awards the practice star of the task's topic after a correct answer. Returns true when awarded. */
export async function maybeAwardPracticeStar(ctx: ServiceContext, task: Task): Promise<boolean> {
  const { db, actor, now } = ctx;
  if (!task.topicId) return false;
  const rows = await db.query<{ data: string }>(
    `SELECT data FROM progress
      WHERE user_id = $1 AND key LIKE 'task:%' AND (data::jsonb ->> 'topicId') = $2`,
    [actor.userId, task.topicId],
  );
  const solved = rows.filter((row) => countsAsSolved(parseJson<unknown>(row.data))).length;
  const key = progressKey.practiceStar(task.topicId);
  const has = Boolean(await getProgress(db, actor.userId, key));
  if (!earnsPracticeStar(solved, has)) return false;
  const topic = await findRecord(db, task.topicId);
  if (topic?.kind !== "topics") return false;
  await saveProgress(db, actor.userId, key, star(topic, "practice", now), now);
  return true;
}
