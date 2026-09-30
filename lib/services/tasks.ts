import type { CheckResult, CodeDraft, RunResult, Task, TaskProgress } from "@/lib/domain/types";
import { badRequest, unprocessable } from "@/lib/server/errors";
import { INPUT_LIMITS, requireBoolean, requireCodeSubmission } from "@/lib/server/validate";
import { requireRecord } from "./content";
import type { ServiceContext } from "./context";
import { isCorrectNumber, requireNumberAnswer } from "./grading";
import { assertNotInActiveMock } from "./mocks";
import { progressKey, saveProgress } from "./progress";
import { executeOnRunner } from "./runner";
import { maybeAwardPracticeStar } from "./stars";

export const DEFAULT_HINT = "Разбей условие на шаги и проверь небольшой пример";

function requireCodeTask(task: Task): void {
  if (task.type !== "code")
    throw badRequest(
      "Это действие доступно только в заданиях по программированию",
      "NOT_CODE_TASK",
    );
}

type TaskInfo = Pick<Task, "title" | "topicId" | "subject" | "type">;

/**
 * Next `task:<id>` progress value after an attempt. A task first solved after its solution was
 * revealed is marked `solvedAfterReveal` (it counts as solved but earns no stars).
 */
export function nextTaskProgress(
  task: TaskInfo,
  previous: Partial<TaskProgress> | null,
  correct: boolean,
): TaskProgress {
  const wasCorrect = Boolean(previous?.correct);
  const next: TaskProgress = {
    title: task.title,
    topicId: task.topicId,
    subject: task.subject,
    correct: correct || wasCorrect,
    lastCorrect: correct,
    attempts: (Number(previous?.attempts) || 0) + 1,
    selfChecked: task.type === "proof",
  };
  if (previous?.revealed) next.revealed = true;
  const solvedAfterReveal = wasCorrect
    ? Boolean(previous?.solvedAfterReveal)
    : correct && Boolean(previous?.revealed);
  if (solvedAfterReveal) next.solvedAfterReveal = true;
  return next;
}

/** Progress after the solution was revealed. Revealing an already solved task changes nothing. */
export function revealedTaskProgress(
  task: TaskInfo,
  previous: TaskProgress | null,
): TaskProgress | null {
  if (previous?.correct) return null;
  return {
    title: task.title,
    topicId: task.topicId,
    subject: task.subject,
    correct: false,
    lastCorrect: previous?.lastCorrect ?? false,
    attempts: Number(previous?.attempts) || 0,
    selfChecked: task.type === "proof",
    revealed: true,
  };
}

/**
 * Checks an answer, stores the attempt and awards the practice star of the topic.
 * Body: `{ answer }` for number tasks, `{ correct }` (self-check) for proofs, `{ code, language }`
 * for programming tasks (graded by the runner against hidden tests).
 */
export async function checkTask(
  ctx: ServiceContext,
  taskId: string,
  body: Record<string, unknown>,
): Promise<CheckResult> {
  const task = await requireRecord(ctx.db, taskId, "tasks", ctx.actor);
  let correct: boolean;
  let output = "";
  if (task.type === "number") {
    requireNumberAnswer(body.answer);
    correct = isCorrectNumber(task, body.answer);
  } else if (task.type === "proof") {
    correct = requireBoolean(
      body.correct,
      "INVALID_SELF_CHECK",
      "Для самопроверки передайте correct: true или false",
    );
  } else {
    const submission = requireCodeSubmission(body);
    await keepCode(ctx, task, submission);
    const result = await executeOnRunner(ctx.env, { ...submission, tests: task.tests ?? [] });
    correct = result.correct;
    output = result.output;
  }

  const progress = await updateTaskProgress(ctx, task, (previous) =>
    nextTaskProgress(task, previous, correct),
  );
  const practiceStar = correct ? await maybeAwardPracticeStar(ctx, task) : false;
  return progress?.solvedAfterReveal
    ? { correct, output, practiceStar, solvedAfterReveal: true }
    : { correct, output, practiceStar };
}

/** Read-modify-write of `task:<id>` under a row lock. `update` returns null to keep the row. */
async function updateTaskProgress(
  ctx: ServiceContext,
  task: Task,
  update: (previous: TaskProgress | null) => TaskProgress | null,
): Promise<TaskProgress | null> {
  const { db, actor, now } = ctx;
  const key = progressKey.task(task.id);
  return db.transaction(async (tx) => {
    const row = await tx.one<{ data: string }>(
      "SELECT data FROM progress WHERE user_id = $1 AND key = $2 FOR UPDATE",
      [actor.userId, key],
    );
    const previous = row ? (JSON.parse(row.data) as TaskProgress) : null;
    const next = update(previous);
    if (next) await saveProgress(tx, actor.userId, key, next, now);
    return next ?? previous;
  });
}

/** Practice run of a programming task with the child's own input (nothing is graded or saved). */
export async function runTask(
  ctx: ServiceContext,
  taskId: string,
  body: Record<string, unknown>,
): Promise<RunResult> {
  const task = await requireRecord(ctx.db, taskId, "tasks", ctx.actor);
  requireCodeTask(task);
  const submission = requireCodeSubmission(body);
  const input = body.input ?? "";
  if (typeof input !== "string" || input.length > INPUT_LIMITS.runInput)
    throw unprocessable("Входные данные слишком длинные", "INVALID_INPUT");
  await keepCode(ctx, task, submission);
  return executeOnRunner(ctx.env, { ...submission, tests: [{ input, output: null }] });
}

export async function revealTask(
  ctx: ServiceContext,
  taskId: string,
): Promise<{ answer?: string; solution: string }> {
  const task = await requireRecord(ctx.db, taskId, "tasks", ctx.actor);
  await assertNotInActiveMock(ctx, task.id);
  await updateTaskProgress(ctx, task, (previous) => revealedTaskProgress(task, previous));
  return task.answer === undefined
    ? { solution: task.solution }
    : { answer: task.answer, solution: task.solution };
}

export async function hintTask(ctx: ServiceContext, taskId: string): Promise<{ hint: string }> {
  const task = await requireRecord(ctx.db, taskId, "tasks", ctx.actor);
  await assertNotInActiveMock(ctx, task.id);
  return { hint: task.hint || DEFAULT_HINT };
}

/**
 * Stores the submitted program as the code draft before it goes to the runner, so it survives a
 * runner failure («Твой код сохранён»).
 */
async function keepCode(ctx: ServiceContext, task: Task, draft: CodeDraft): Promise<void> {
  await saveProgress(ctx.db, ctx.actor.userId, progressKey.code(task.id), draft, ctx.now);
}

/** Autosave of the code editor (`code:<taskId>`). */
export async function saveCodeDraft(
  ctx: ServiceContext,
  taskId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const task = await requireRecord(ctx.db, taskId, "tasks", ctx.actor);
  requireCodeTask(task);
  await keepCode(ctx, task, requireCodeSubmission(body));
}
