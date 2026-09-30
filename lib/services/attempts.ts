// Stored mock attempts and how they are shown to the client.
import type {
  MockAttempt,
  MockResult,
  MockResultStatus,
  PublicTask,
  ReviewedTask,
  Task,
} from "@/lib/domain/types";
import { publicTask, reviewedTask } from "./content";

/** Attempt as stored on the server: full tasks (answers, hidden tests) stay in the database. */
export type StoredAttempt = MockAttempt<Task>;
export type ClientAttempt = MockAttempt<PublicTask> | MockAttempt<ReviewedTask>;

export const UNCHECKED_NOTE = "Проверим, когда снова заработает проверка программ";
export const SELF_CHECK_NOTE = "Самопроверка после завершения";

export function isAttempt(value: unknown): value is StoredAttempt {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { tasks?: unknown }).tasks)
  );
}

/**
 * Hides what the client must not see in stored progress: tasks of an unfinished attempt lose their
 * answers and solutions; hidden code tests are removed in every case.
 */
export function sanitizeAttempt(
  attempt: StoredAttempt,
): MockAttempt<PublicTask> | MockAttempt<ReviewedTask> {
  if (attempt.finished) return { ...attempt, tasks: attempt.tasks.map(reviewedTask) };
  return { ...attempt, tasks: attempt.tasks.map(publicTask) };
}

export function totals(results: readonly MockResult[]): {
  score: number;
  max: number;
  pending: number;
} {
  return {
    score: results.reduce((sum, item) => sum + (item.correct ? item.points : 0), 0),
    max: results.reduce((sum, item) => sum + item.max, 0),
    pending: results.filter((item) => item.status === "unchecked").length,
  };
}

/** Status of results stored before statuses existed. */
export function resultStatus(item: MockResult, task: Task | undefined): MockResultStatus {
  if (item.status) return item.status;
  if (item.correct) return "correct";
  if (task?.type === "proof" && item.note === SELF_CHECK_NOTE) return "self-check";
  return "wrong";
}

/** Upgrades legacy finished attempts (no `status`/`pending`) and sanitises tasks. */
export function presentAttempt(attempt: StoredAttempt): ClientAttempt {
  if (!attempt.finished || !attempt.results) return sanitizeAttempt(attempt);
  const tasks = new Map(attempt.tasks.map((task) => [task.id, task]));
  const results = attempt.results.map((item) => ({
    ...item,
    status: resultStatus(item, tasks.get(item.id)),
  }));
  return sanitizeAttempt({ ...attempt, results, pending: totals(results).pending });
}
