import type {
  CodeLanguage,
  MockAttempt,
  MockResult,
  MockResultStatus,
  MockTest,
  PublicTask,
  ReviewedTask,
  Task,
} from "@/lib/domain/types";
import { parseJson, type Db } from "@/lib/server/db";
import { ApiError, conflict, notFound } from "@/lib/server/errors";
import {
  applyAnswerPatch,
  isCodeLanguage,
  parseMockAnswers,
  type MockAnswerOptions,
  type MockAnswerPatch,
} from "@/lib/server/validate";
import { isVisibleTo, requireRecord } from "./content";
import type { ServiceContext } from "./context";
import { isCorrectNumber, taskPoints } from "./grading";
import {
  presentAttempt,
  resultStatus,
  sanitizeAttempt,
  SELF_CHECK_NOTE,
  totals,
  UNCHECKED_NOTE,
  type ClientAttempt,
  type StoredAttempt,
} from "./attempts";
import { getProgress, progressKey, saveProgress } from "./progress";
import { executeOnRunner } from "./runner";

export {
  presentAttempt,
  resultStatus,
  SELF_CHECK_NOTE,
  totals,
  UNCHECKED_NOTE,
  type StoredAttempt,
} from "./attempts";

/** Answers that arrive this late after `ends` are still accepted (network latency, auto-finish). */
export const MOCK_SUBMIT_GRACE_MS = 5_000;
/** Tasks drawn from a randomised mock when `taskCount` is not set. */
export const DEFAULT_RANDOM_TASK_COUNT = 10;

const attemptNotFound = () => notFound("Попытка не найдена", "ATTEMPT_NOT_FOUND");

/** Task ids of a new attempt: all tasks in order, or a random sample for randomised mocks. */
export function pickTaskIds(test: MockTest, random: () => number = Math.random): string[] {
  const ids = [...test.taskIds];
  if (!test.randomize) return ids;
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.max(1, Number(test.taskCount) || DEFAULT_RANDOM_TASK_COUNT));
}

export function isAcceptingAnswers(attempt: StoredAttempt, now: number): boolean {
  return !attempt.finished && now <= attempt.ends + MOCK_SUBMIT_GRACE_MS;
}

export type CodeGrader = (
  task: Task,
  answer: { code: string; language: CodeLanguage },
) => Promise<boolean>;

/** Runner failures that say nothing about the child's code: the answer stays `unchecked`. */
function isTemporaryFailure(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
}

function result(task: Task, status: MockResultStatus, note = ""): MockResult {
  const max = taskPoints(task);
  const correct = status === "correct";
  return { id: task.id, correct, points: correct ? max : 0, max, note, status };
}

async function gradeCode(
  task: Task,
  answer: unknown,
  gradeCodeAnswer: CodeGrader,
): Promise<MockResult> {
  // Attempts stored by older versions were not validated: anything but real code is "wrong".
  const submission = answer as { code?: unknown; language?: unknown } | null;
  if (
    typeof submission !== "object" ||
    submission === null ||
    typeof submission.code !== "string" ||
    !submission.code.trim() ||
    !isCodeLanguage(submission.language)
  )
    return result(task, "wrong");
  try {
    const code = { code: submission.code, language: submission.language };
    return result(task, (await gradeCodeAnswer(task, code)) ? "correct" : "wrong");
  } catch (error) {
    if (isTemporaryFailure(error)) {
      if (!(error instanceof ApiError)) console.error("[olympus] mock code grading failed:", error);
      return result(task, "unchecked", UNCHECKED_NOTE);
    }
    return result(task, "wrong", (error as ApiError).message);
  }
}

/**
 * Grades every task of an attempt. Number answers are compared, proofs wait for the child's
 * self-check, code goes to the runner. When the runner is down, code answers stay `unchecked`
 * (no points yet) instead of being marked wrong.
 */
export async function gradeAttempt(
  attempt: StoredAttempt,
  gradeCodeAnswer: CodeGrader,
): Promise<{ results: MockResult[]; score: number; max: number; pending: number }> {
  const results: MockResult[] = [];
  for (const task of attempt.tasks) {
    const answer = attempt.answers[task.id];
    if (task.type === "number")
      results.push(
        result(
          task,
          typeof answer === "string" && isCorrectNumber(task, answer) ? "correct" : "wrong",
        ),
      );
    else if (task.type === "proof") results.push(result(task, "self-check", SELF_CHECK_NOTE));
    else results.push(await gradeCode(task, answer, gradeCodeAnswer));
  }
  return { results, ...totals(results) };
}

function runnerGrader(ctx: ServiceContext): CodeGrader {
  return async (task, answer) => {
    const outcome = await executeOnRunner(ctx.env, {
      code: answer.code,
      language: answer.language,
      tests: task.tests ?? [],
    });
    return outcome.correct;
  };
}

async function loadAttempt(db: Db, userId: string, attemptId: string): Promise<StoredAttempt> {
  const attempt = await getProgress<StoredAttempt>(db, userId, progressKey.attempt(attemptId));
  if (!attempt || !Array.isArray(attempt.tasks)) throw attemptNotFound();
  return attempt;
}

/** Loads the attempt with a row lock; must be called inside a transaction. */
async function lockAttempt(db: Db, userId: string, attemptId: string): Promise<StoredAttempt> {
  const row = await db.one<{ data: string }>(
    "SELECT data FROM progress WHERE user_id = $1 AND key = $2 FOR UPDATE",
    [userId, progressKey.attempt(attemptId)],
  );
  const attempt = parseJson<StoredAttempt>(row?.data);
  if (!attempt || !Array.isArray(attempt.tasks)) throw attemptNotFound();
  return attempt;
}

function taskIds(attempt: StoredAttempt): string[] {
  return attempt.tasks.map((task) => task.id);
}

export async function startMock(
  ctx: ServiceContext,
  mockId: string,
): Promise<MockAttempt<PublicTask>> {
  const { db, actor, now } = ctx;
  const test = await requireRecord(db, mockId, "mock-tests", actor);
  const ids = pickTaskIds(test);
  const rows = await db.query<{ data: string }>(
    "SELECT data FROM records WHERE deleted = 0 AND kind = 'tasks' AND id = ANY($1::text[])",
    [ids],
  );
  const byId = new Map<string, Task>();
  for (const row of rows) {
    const task = parseJson<Task>(row.data);
    if (task && isVisibleTo(task, actor)) byId.set(task.id, task);
  }
  const tasks = ids.flatMap((id) => byId.get(id) ?? []);
  if (!tasks.length) throw notFound("В этом пробнике пока нет заданий", "MOCK_NOT_FOUND");
  const attempt: StoredAttempt = {
    id: crypto.randomUUID(),
    testId: test.id,
    title: test.title,
    subject: test.subject,
    started: now,
    ends: now + Number(test.minutes) * 60_000,
    tasks,
    answers: {},
    finished: false,
  };
  await saveProgress(db, actor.userId, progressKey.attempt(attempt.id), attempt, now);
  return sanitizeAttempt(attempt) as MockAttempt<PublicTask>;
}

/** The caller's attempt as the client may see it (404 for other users' attempts). */
export async function getAttempt(ctx: ServiceContext, attemptId: string): Promise<ClientAttempt> {
  return presentAttempt(await loadAttempt(ctx.db, ctx.actor.userId, attemptId));
}

export type SaveMockOutcome =
  | { status: "saved"; attempt: MockAttempt<PublicTask> }
  | { status: "finished"; attempt: MockAttempt<ReviewedTask> }
  | { status: "expired" };

/** Autosave: merges the answer patch into the stored answers while the attempt is running. */
export async function saveMockAnswers(
  ctx: ServiceContext,
  attemptId: string,
  rawAnswers: unknown,
  options: MockAnswerOptions = {},
): Promise<SaveMockOutcome> {
  const { db, actor, now } = ctx;
  return db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, actor.userId, attemptId);
    const patch = parseMockAnswers(rawAnswers, taskIds(attempt), options);
    if (attempt.finished)
      return { status: "finished", attempt: presentAttempt(attempt) as MockAttempt<ReviewedTask> };
    if (!isAcceptingAnswers(attempt, now)) return { status: "expired" };
    const updated: StoredAttempt = {
      ...attempt,
      answers: applyAnswerPatch(attempt.answers, patch),
    };
    await saveProgress(tx, actor.userId, progressKey.attempt(attemptId), updated, now);
    return { status: "saved", attempt: sanitizeAttempt(updated) as MockAttempt<PublicTask> };
  });
}

/**
 * Finishes and grades an attempt. Idempotent: a finished attempt is returned as is. An answer patch
 * sent with the request is merged first, while the attempt still accepts answers.
 */
export async function finishMock(
  ctx: ServiceContext,
  attemptId: string,
  rawAnswers?: unknown,
  options: MockAnswerOptions = {},
): Promise<MockAttempt<ReviewedTask>> {
  const { db, actor, now } = ctx;
  // Merge the last answers under a row lock, then grade outside the transaction (the runner may
  // take a while) and store the result only if nobody finished the attempt in between.
  const prepared = await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, actor.userId, attemptId);
    const patch: MockAnswerPatch | null =
      rawAnswers === undefined ? null : parseMockAnswers(rawAnswers, taskIds(attempt), options);
    if (attempt.finished) return { done: attempt };
    if (patch && isAcceptingAnswers(attempt, now)) {
      attempt.answers = applyAnswerPatch(attempt.answers, patch);
      await saveProgress(tx, actor.userId, progressKey.attempt(attemptId), attempt, now);
    }
    return { pending: attempt };
  });
  if (prepared.done) return presentAttempt(prepared.done) as MockAttempt<ReviewedTask>;

  const attempt = prepared.pending as StoredAttempt;
  const graded = await gradeAttempt(attempt, runnerGrader(ctx));
  const finished: StoredAttempt = { ...attempt, finished: true, finishedAt: now, ...graded };
  const stored = await db.transaction(async (tx) => {
    const current = await lockAttempt(tx, actor.userId, attemptId);
    if (current.finished) return current;
    await saveProgress(tx, actor.userId, progressKey.attempt(attemptId), finished, now);
    return finished;
  });
  return presentAttempt(stored) as MockAttempt<ReviewedTask>;
}

/** Re-grades `unchecked` code answers of a finished attempt. */
export async function recheckMock(
  ctx: ServiceContext,
  attemptId: string,
): Promise<MockAttempt<ReviewedTask>> {
  const { db, actor, now } = ctx;
  const attempt = await loadAttempt(db, actor.userId, attemptId);
  if (!attempt.finished || !attempt.results)
    throw conflict("Сначала заверши пробник", "MOCK_NOT_FINISHED");
  const tasks = new Map(attempt.tasks.map((task) => [task.id, task]));
  const regraded = new Map<string, MockResult>();
  for (const item of attempt.results) {
    const task = tasks.get(item.id);
    if (!task || task.type !== "code" || resultStatus(item, task) !== "unchecked") continue;
    const next = await gradeCode(task, attempt.answers[task.id], runnerGrader(ctx));
    if (next.status !== "unchecked") regraded.set(task.id, next);
  }
  if (!regraded.size) return presentAttempt(attempt) as MockAttempt<ReviewedTask>;

  const stored = await db.transaction(async (tx) => {
    const current = await lockAttempt(tx, actor.userId, attemptId);
    const results = (current.results ?? []).map((item) =>
      item.status === "unchecked" && regraded.has(item.id) ? regraded.get(item.id)! : item,
    );
    const updated: StoredAttempt = { ...current, results, ...totals(results) };
    await saveProgress(tx, actor.userId, progressKey.attempt(attemptId), updated, now);
    return updated;
  });
  return presentAttempt(stored) as MockAttempt<ReviewedTask>;
}

/** Self-check of a proof task after the attempt is finished. */
export async function setProofResult(
  ctx: ServiceContext,
  attemptId: string,
  taskId: string,
  correct: boolean,
): Promise<MockAttempt<ReviewedTask>> {
  const { db, actor, now } = ctx;
  const stored = await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, actor.userId, attemptId);
    if (!attempt.finished || !attempt.results)
      throw conflict("Сначала заверши пробник", "MOCK_NOT_FINISHED");
    const task = attempt.tasks.find((item) => item.id === taskId && item.type === "proof");
    if (!task || !attempt.results.some((item) => item.id === taskId))
      throw notFound("Задание не найдено в этом пробнике", "TASK_NOT_FOUND");
    const results = attempt.results.map((item) =>
      item.id === taskId ? result(task, correct ? "correct" : "wrong", "Самопроверка") : item,
    );
    const updated: StoredAttempt = { ...attempt, results, ...totals(results) };
    await saveProgress(tx, actor.userId, progressKey.attempt(attemptId), updated, now);
    return updated;
  });
  return presentAttempt(stored) as MockAttempt<ReviewedTask>;
}

/** True when the task is part of the actor's unfinished, not yet expired attempt. */
export async function isInActiveMock(ctx: ServiceContext, taskId: string): Promise<boolean> {
  const rows = await ctx.db.query<{ data: string }>(
    `SELECT data FROM progress
      WHERE user_id = $1 AND key LIKE 'attempt:%' AND (data::jsonb ->> 'finished') = 'false'`,
    [ctx.actor.userId],
  );
  return rows.some((row) => {
    const attempt = parseJson<StoredAttempt>(row.data);
    return (
      !!attempt &&
      isAcceptingAnswers(attempt, ctx.now) &&
      attempt.tasks.some((task) => task.id === taskId)
    );
  });
}

export async function assertNotInActiveMock(ctx: ServiceContext, taskId: string): Promise<void> {
  if (await isInActiveMock(ctx, taskId))
    throw conflict(
      "Подсказка и решение откроются после пробника – сейчас в нём есть это задание",
      "MOCK_IN_PROGRESS",
    );
}
