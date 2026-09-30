import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  INTERNAL_ERROR_MESSAGE,
  isDatabaseUnavailable,
  notFound,
  rpcErrorBody,
  toApiError,
  tooManyRequests,
  unauthorized,
  unavailable,
  unprocessable,
  v1ErrorBody,
} from "@/lib/server/errors";

describe("error helpers", () => {
  it.each([
    [badRequest("m"), 400, "INVALID_REQUEST"],
    [unauthorized("m", "SESSION_EXPIRED"), 401, "SESSION_EXPIRED"],
    [forbidden("m", "BAD_ORIGIN"), 403, "BAD_ORIGIN"],
    [notFound("m"), 404, "NOT_FOUND"],
    [conflict("m", "MOCK_IN_PROGRESS"), 409, "MOCK_IN_PROGRESS"],
    [unprocessable("m", "INVALID_ANSWER"), 422, "INVALID_ANSWER"],
    [unavailable("m", "RUNNER_UNAVAILABLE"), 503, "RUNNER_UNAVAILABLE"],
  ])("builds %s", (error, status, code) => {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code, message: "m", name: "ApiError" });
  });

  it.each([
    [0.2, "1"],
    [1.5, "2"],
    [60, "60"],
    [-5, "1"],
  ])("tooManyRequests(%s) sets Retry-After %s", (seconds, header) => {
    const error = tooManyRequests("Подожди", seconds);
    expect(error).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      headers: { "Retry-After": header },
    });
  });
});

describe("isDatabaseUnavailable", () => {
  it.each([
    [{ code: "08006" }, true],
    [{ code: "08001" }, true],
    [{ code: "57P01" }, true],
    [{ code: "53300" }, true],
    [{ code: "ECONNREFUSED" }, true],
    [{ code: "ETIMEDOUT" }, true],
    [new Error("Connection terminated unexpectedly"), true],
    [new Error("connect ECONNREFUSED 127.0.0.1:5432"), true],
    [{ code: "23505", message: "duplicate key" }, false],
    [{ code: "42P01", message: 'relation "x" does not exist' }, false],
    [new TypeError("x is undefined"), false],
    ["Connection terminated", false],
    [null, false],
  ])("%j → %s", (error, expected) => {
    expect(isDatabaseUnavailable(error)).toBe(expected);
  });
});

describe("toApiError", () => {
  it("passes ApiErrors through without logging", () => {
    const log = vi.fn();
    const error = notFound("Нет", "TASK_NOT_FOUND");
    expect(toApiError(error, log)).toBe(error);
    expect(log).not.toHaveBeenCalled();
  });

  it("maps database outages to 503 DATABASE_UNAVAILABLE", () => {
    const log = vi.fn();
    const mapped = toApiError(
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
      log,
    );
    expect(mapped).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE" });
    expect(log).toHaveBeenCalledOnce();
  });

  it("hides unexpected errors behind a generic 500 and logs the original", () => {
    const log = vi.fn();
    const original = new Error('syntax error at or near "SELEC" in SELECT * FROM sessions');
    const mapped = toApiError(original, log);
    expect(mapped).toMatchObject({
      status: 500,
      code: "SERVER_ERROR",
      message: INTERNAL_ERROR_MESSAGE,
    });
    // The mini-app client knows SERVER_ERROR; openapi.yaml documents INTERNAL_ERROR for /api/v1.
    expect(rpcErrorBody(mapped).code).toBe("SERVER_ERROR");
    expect(v1ErrorBody(mapped).error.code).toBe("INTERNAL_ERROR");
    const serialised = JSON.stringify([rpcErrorBody(mapped), v1ErrorBody(mapped)]);
    expect(serialised).not.toMatch(/SELEC|sessions|syntax/);
    expect(log).toHaveBeenCalledWith(expect.any(String), original);
  });

  it("handles thrown non-errors", () => {
    expect(toApiError("boom", () => undefined).status).toBe(500);
    expect(toApiError(undefined, () => undefined).status).toBe(500);
  });
});

describe("error bodies", () => {
  const error = conflict("Пробник уже завершён", "ATTEMPT_FINISHED");

  it("RPC: { error: message, code }", () => {
    expect(rpcErrorBody(error)).toEqual({
      error: "Пробник уже завершён",
      code: "ATTEMPT_FINISHED",
    });
  });

  it("v1: { error: { code, message } }", () => {
    expect(v1ErrorBody(error)).toEqual({
      error: { code: "ATTEMPT_FINISHED", message: "Пробник уже завершён" },
    });
  });
});
