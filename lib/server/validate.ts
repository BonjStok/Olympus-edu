// Small hand-written validators for request bodies (bodies are `unknown` until checked here).
import {
  CODE_LANGUAGES,
  INPUT_LIMITS as SHARED_INPUT_LIMITS,
  type ApiErrorCode,
  type CodeLanguage,
  type MockAnswer,
} from "@/lib/domain/types";
import { ID_PATTERN } from "@/lib/content/validate.mjs";
import { badRequest, unprocessable } from "./errors";

export const INPUT_LIMITS = {
  ...SHARED_INPUT_LIMITS,
  initData: 8_192,
  password: 512,
  username: 128,
} as const;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Required record/attempt id from a request body. */
export function requireId(value: unknown, field = "id"): string {
  if (value === undefined || value === null || value === "")
    throw badRequest(`Не указан ${field}`, "INVALID_ID");
  if (!isValidId(value)) throw badRequest(`Некорректный ${field}`, "INVALID_ID");
  return value;
}

export function requireBoolean(value: unknown, code: ApiErrorCode, message: string): boolean {
  if (typeof value !== "boolean") throw unprocessable(message, code);
  return value;
}

export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return typeof value === "string" && (CODE_LANGUAGES as readonly string[]).includes(value);
}

export function requireLanguage(value: unknown): CodeLanguage {
  if (!isCodeLanguage(value))
    throw unprocessable("Выберите поддерживаемый язык программирования", "INVALID_LANGUAGE");
  return value;
}

export function requireCode(value: unknown): string {
  if (typeof value !== "string")
    throw unprocessable("Передайте код программы строкой", "INVALID_CODE");
  if (value.length > INPUT_LIMITS.code)
    throw unprocessable(
      `Код слишком длинный: максимум ${INPUT_LIMITS.code} символов`,
      "INVALID_CODE",
    );
  return value;
}

/** `{ code, language }` with the same limits as a code check. */
export function requireCodeSubmission(body: Record<string, unknown>): {
  code: string;
  language: CodeLanguage;
} {
  return { code: requireCode(body.code), language: requireLanguage(body.language) };
}

/** Patch of mock answers: a value replaces the stored answer, `null` removes it. */
export type MockAnswerPatch = Record<string, MockAnswer | null>;

export interface MockAnswerOptions {
  /**
   * `strict` (mini-app RPC, default): keys must be task ids of the attempt, values strings or code.
   * `lenient` (`/api/v1`, keeps the DATA-API behaviour of the first release): keys of other tasks
   * are ignored and numbers are accepted as text answers.
   */
  mode?: "strict" | "lenient";
}

/**
 * Answers of a mock attempt: an object keyed by the attempt's task ids. Values are text answers
 * (≤ 2 000 chars) or code submissions `{ code ≤ 50 000, language }`; `""` or `null` clears an
 * answer. The result is a patch that is merged into the stored answers.
 */
export function parseMockAnswers(
  value: unknown,
  taskIds: readonly string[],
  options: MockAnswerOptions = {},
): MockAnswerPatch {
  const lenient = options.mode === "lenient";
  if (!isPlainObject(value))
    throw unprocessable("answers должен быть объектом { taskId: ответ }", "INVALID_ANSWERS");
  const allowed = new Set(taskIds);
  const patch: MockAnswerPatch = {};
  for (const [taskId, raw] of Object.entries(value)) {
    if (!allowed.has(taskId)) {
      if (lenient) continue;
      throw unprocessable("Этого задания нет в пробнике", "INVALID_ANSWERS");
    }
    const answer = lenient && typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
    if (answer === null || answer === "") {
      patch[taskId] = null;
    } else if (typeof answer === "string") {
      if (answer.length > INPUT_LIMITS.textAnswer)
        throw unprocessable(
          `Ответ слишком длинный: максимум ${INPUT_LIMITS.textAnswer} символов`,
          "INVALID_ANSWERS",
        );
      patch[taskId] = answer;
    } else if (isPlainObject(answer)) {
      if (typeof answer.code !== "string" || answer.code.length > INPUT_LIMITS.code)
        throw unprocessable(
          `Код слишком длинный: максимум ${INPUT_LIMITS.code} символов`,
          "INVALID_ANSWERS",
        );
      if (!isCodeLanguage(answer.language))
        throw unprocessable("Выбери язык программирования из списка", "INVALID_ANSWERS");
      patch[taskId] = { code: answer.code, language: answer.language };
    } else {
      throw unprocessable("Ответ должен быть строкой или { code, language }", "INVALID_ANSWERS");
    }
  }
  return patch;
}

export function applyAnswerPatch(
  current: Readonly<Record<string, MockAnswer>>,
  patch: MockAnswerPatch,
): Record<string, MockAnswer> {
  const next: Record<string, MockAnswer> = { ...current };
  for (const [taskId, answer] of Object.entries(patch)) {
    if (answer === null) delete next[taskId];
    else next[taskId] = answer;
  }
  return next;
}
