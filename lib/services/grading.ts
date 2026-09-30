import type { Task } from "@/lib/domain/types";
import { NUMBER_ANSWER_PATTERN } from "@/lib/content/validate.mjs";
import { unprocessable } from "@/lib/server/errors";

/**
 * Parses a numeric answer typed by a child: integer or decimal, optional sign, "." or "," as the
 * decimal separator ("1,5" → 1.5, "+3" → 3). Returns null for anything else ("abc", "", "1e3").
 */
export function parseNumberAnswer(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length > 100 || !NUMBER_ANSWER_PATTERN.test(text)) return null;
  return Number(text.replace(",", "."));
}

export const INVALID_NUMBER_MESSAGE = "Введите число, например 12 или 0,5";

/** Number the child entered, or 422 `INVALID_ANSWER` when it is not a number. */
export function requireNumberAnswer(raw: unknown): number {
  const value = parseNumberAnswer(raw);
  if (value === null) throw unprocessable(INVALID_NUMBER_MESSAGE, "INVALID_ANSWER");
  return value;
}

/** Compares a child's answer with the task's reference answer. Invalid input is simply wrong. */
export function isCorrectNumber(task: Pick<Task, "answer">, raw: unknown): boolean {
  const expected = parseNumberAnswer(task.answer);
  const actual = parseNumberAnswer(raw);
  return expected !== null && actual !== null && expected === actual;
}

export function taskPoints(task: Pick<Task, "points">): number {
  const points = Number(task.points ?? 1);
  return Number.isFinite(points) && points >= 0 ? points : 1;
}
