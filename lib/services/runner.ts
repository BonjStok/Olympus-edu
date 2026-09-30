// HTTP client of the code runner (runner/server.mjs → Judge0). User code never runs in the web
// container itself.
import type { CodeLanguage, RunResult } from "@/lib/domain/types";
import { ApiError } from "@/lib/server/errors";
import type { ServerEnv } from "@/lib/server/env";

export interface RunnerTest {
  input: string;
  /** `null` for a practice run: the output is returned instead of being compared. */
  output: string | null;
}

export interface RunnerSubmission {
  code: string;
  language: CodeLanguage;
  tests: RunnerTest[];
}

export interface RunnerOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Shown to children whenever programs cannot be checked right now (never the runner's own text). */
export const RUNNER_UNAVAILABLE_MESSAGE =
  "Проверка программ сейчас не работает. Твой код сохранён – попробуй позже.";
const RUNNER_BUSY_MESSAGE = "Проверка программ сейчас занята. Попробуй через несколько секунд";
const RUNNER_REJECTED_MESSAGE = "Программа слишком большая или содержит недопустимые данные";

function runnerMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** Sends code to the runner and maps its failures to user-facing API errors. */
export async function executeOnRunner(
  env: Pick<ServerEnv, "RUNNER_URL" | "RUNNER_TOKEN">,
  submission: RunnerSubmission,
  options: RunnerOptions = {},
): Promise<RunResult> {
  if (!env.RUNNER_URL) throw new ApiError(503, "RUNNER_UNAVAILABLE", RUNNER_UNAVAILABLE_MESSAGE);
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(env.RUNNER_URL.replace(/\/$/, "") + "/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.RUNNER_TOKEN ? { Authorization: `Bearer ${env.RUNNER_TOKEN}` } : {}),
      },
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(options.timeoutMs ?? 55_000),
    });
  } catch (error) {
    console.error("[olympus] runner request failed:", error);
    throw new ApiError(503, "RUNNER_UNAVAILABLE", RUNNER_UNAVAILABLE_MESSAGE);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = runnerMessage(payload);
    // The runner's own message is technical (Judge0 details): log it, never show it.
    console.error("[olympus] runner responded", response.status, message);
    if (response.status === 429)
      throw new ApiError(429, "RUNNER_BUSY", RUNNER_BUSY_MESSAGE, {
        "Retry-After": /^\d{1,3}$/.test(response.headers.get("retry-after") ?? "")
          ? (response.headers.get("retry-after") as string)
          : "2",
      });
    if (response.status === 413 || response.status === 422)
      throw new ApiError(422, "INVALID_CODE", RUNNER_REJECTED_MESSAGE);
    throw new ApiError(503, "RUNNER_UNAVAILABLE", RUNNER_UNAVAILABLE_MESSAGE);
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as RunResult).correct !== "boolean"
  ) {
    console.error("[olympus] runner returned an invalid body");
    throw new ApiError(503, "RUNNER_UNAVAILABLE", RUNNER_UNAVAILABLE_MESSAGE);
  }
  const result = payload as RunResult;
  return {
    correct: result.correct,
    output: typeof result.output === "string" ? result.output : "",
    ...(typeof result.passed === "number" ? { passed: result.passed } : {}),
    ...(typeof result.total === "number" ? { total: result.total } : {}),
  };
}
