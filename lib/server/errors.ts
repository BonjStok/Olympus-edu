import type { ApiErrorBody, ApiErrorCode } from "@/lib/domain/types";

/**
 * An expected failure with an HTTP status, a stable machine-readable code and a Russian message
 * that can be shown to the user as is. Anything that is not an `ApiError` is treated as a bug:
 * it is logged and reported as a generic 500.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Malformed request: invalid JSON, missing or ill-typed fields, unknown action. */
export const badRequest = (message: string, code: ApiErrorCode = "INVALID_REQUEST") =>
  new ApiError(400, code, message);
export const unauthorized = (message: string, code: ApiErrorCode) =>
  new ApiError(401, code, message);
export const forbidden = (message: string, code: ApiErrorCode) => new ApiError(403, code, message);
export const notFound = (message: string, code: ApiErrorCode = "NOT_FOUND") =>
  new ApiError(404, code, message);
export const conflict = (message: string, code: ApiErrorCode) => new ApiError(409, code, message);
/** Well-formed request with a value that cannot be processed (answer, language, code...). */
export const unprocessable = (message: string, code: ApiErrorCode) =>
  new ApiError(422, code, message);
export const unavailable = (message: string, code: ApiErrorCode) =>
  new ApiError(503, code, message);
export const tooManyRequests = (
  message: string,
  retryAfterSeconds: number,
  code: ApiErrorCode = "RATE_LIMITED",
) =>
  new ApiError(429, code, message, {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });

export const INTERNAL_ERROR_MESSAGE = "Что-то пошло не так. Попробуйте ещё раз чуть позже";
const DATABASE_UNAVAILABLE_MESSAGE =
  "База данных временно недоступна. Попробуйте ещё раз чуть позже";

/** PostgreSQL / socket failures that mean "the database is down", not "the code is wrong". */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  const message = String((error as { message?: unknown }).message ?? "");
  return (
    /^(08|57P0[1-3]|53300)/.test(code) ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code) ||
    /Connection terminated|timeout expired|connect ECONNREFUSED/i.test(message)
  );
}

/**
 * Turns any thrown value into an `ApiError`. Unexpected errors are logged with their stack on the
 * server and replaced by a generic message, so SQL, stack traces and internals never leak.
 */
export function toApiError(
  error: unknown,
  log: (...args: unknown[]) => void = console.error,
): ApiError {
  if (error instanceof ApiError) return error;
  if (isDatabaseUnavailable(error)) {
    log("[olympus] database unavailable:", error);
    return new ApiError(503, "DATABASE_UNAVAILABLE", DATABASE_UNAVAILABLE_MESSAGE);
  }
  log("[olympus] unexpected error:", error);
  return new ApiError(500, "SERVER_ERROR", INTERNAL_ERROR_MESSAGE);
}

/** Error body of the mini-app RPC (`/api/olympus`). */
export function rpcErrorBody(error: ApiError): ApiErrorBody {
  return { error: error.message, code: error.code };
}

/** Error body of the public evaluator API (`/api/v1`, see openapi.yaml: 500 is INTERNAL_ERROR). */
export function v1ErrorBody(error: ApiError): { error: { code: string; message: string } } {
  const code = error.code === "SERVER_ERROR" ? "INTERNAL_ERROR" : error.code;
  return { error: { code, message: error.message } };
}
