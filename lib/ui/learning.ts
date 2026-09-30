/** Learning path: per-topic progress, the recommended next topic, prompt formatting. */
import type { LessonSummary, ProgressMap, TaskSummary, Topic } from "@/lib/domain/types";
import {
  PRACTICE_STAR_GOAL,
  countsAsSolved,
  hasPracticeStar,
  hasTheoryStar,
  isLessonRead,
  taskProgress,
} from "./progress";

export interface TopicStatus {
  lessonsRead: number;
  lessonsTotal: number;
  solved: number;
  tasksTotal: number;
  theoryStar: boolean;
  practiceStar: boolean;
  started: boolean;
  done: boolean;
}

export function topicStatus(
  topicId: string,
  lessons: readonly Pick<LessonSummary, "id">[],
  tasks: readonly Pick<TaskSummary, "id">[],
  p: ProgressMap,
): TopicStatus {
  const lessonsRead = lessons.filter((l) => isLessonRead(p, l.id)).length;
  const solved = tasks.filter((t) => countsAsSolved(taskProgress(p, t.id))).length;
  const theoryStar = hasTheoryStar(p, topicId);
  const practiceStar = hasPracticeStar(p, topicId);
  const tasksTried = tasks.some((t) => taskProgress(p, t.id));
  return {
    lessonsRead,
    lessonsTotal: lessons.length,
    solved,
    tasksTotal: tasks.length,
    theoryStar,
    practiceStar,
    started: lessonsRead > 0 || tasksTried || theoryStar || practiceStar,
    done: theoryStar && (practiceStar || tasks.length === 0),
  };
}

/** Tasks still needed for the practice star. */
export function tasksToStar(status: TopicStatus): number {
  return Math.max(0, Math.min(PRACTICE_STAR_GOAL, status.tasksTotal) - status.solved);
}

/** First topic that is not finished, preferring one already started. */
export function recommendedTopic<T extends Pick<Topic, "id">>(
  topics: readonly T[],
  statusOf: (id: string) => TopicStatus,
): T | undefined {
  const notDone = topics.filter((t) => !statusOf(t.id).done);
  return notDone.find((t) => statusOf(t.id).started) ?? notDone[0];
}

/** Where to open a topic: theory until its star, then practice. */
export function entryPart(status: TopicStatus): "theory" | "practice" {
  return status.theoryStar || status.lessonsTotal === 0 ? "practice" : "theory";
}

/** First unread lesson / first unsolved task, for resuming. */
export function firstUnfinished<T extends { id: string }>(
  items: readonly T[],
  isDone: (id: string) => boolean,
): number {
  const i = items.findIndex((it) => !isDone(it.id));
  return i < 0 ? 0 : i;
}

export type PromptPart =
  { type: "text"; value: string } | { type: "code"; value: string; lang?: string };

/** Splits a task prompt into text and fenced ```code``` blocks. */
export function splitPrompt(prompt: string): PromptPart[] {
  const parts: PromptPart[] = [];
  const re = /```([\w+-]*)[ \t]*\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const before = prompt.slice(last, m.index).trim();
    if (before) parts.push({ type: "text", value: before });
    parts.push({ type: "code", value: m[2].replace(/\n$/, ""), lang: m[1] || undefined });
    last = m.index + m[0].length;
  }
  const rest = prompt.slice(last).trim();
  if (rest) parts.push({ type: "text", value: rest });
  return parts;
}
