import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/server/errors";
import { executeOnRunner, RUNNER_UNAVAILABLE_MESSAGE } from "@/lib/services/runner";

const submission = {
  code: "print(int(input()) * 2)",
  language: "python" as const,
  tests: [{ input: "2", output: "4" }],
};
const env = { RUNNER_URL: "http://runner:8080/", RUNNER_TOKEN: "secret" };

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
  );
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected an ApiError");
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("executeOnRunner", () => {
  it("posts the submission with the runner token and maps the result", async () => {
    const fetch = fakeFetch(200, { correct: true, output: "OK", passed: 3, total: 3, extra: "x" });
    const result = await executeOnRunner(env, submission, { fetch });
    expect(result).toEqual({ correct: true, output: "OK", passed: 3, total: 3 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://runner:8080/execute");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(String(init?.body))).toEqual(submission);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits Authorization without a token and defaults missing fields", async () => {
    const fetch = fakeFetch(200, { correct: false });
    const result = await executeOnRunner(
      { RUNNER_URL: "http://runner", RUNNER_TOKEN: "" },
      submission,
      { fetch },
    );
    expect(result).toEqual({ correct: false, output: "" });
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  });

  it("answers 503 when the runner is not configured, without any request", async () => {
    const fetch = fakeFetch(200, {});
    const error = await caught(
      executeOnRunner({ RUNNER_URL: "", RUNNER_TOKEN: "" }, submission, { fetch }),
    );
    expect(error).toMatchObject({
      status: 503,
      code: "RUNNER_UNAVAILABLE",
      message: RUNNER_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 503 on network errors and timeouts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await caught(executeOnRunner(env, submission, { fetch }))).toMatchObject({
      status: 503,
      code: "RUNNER_UNAVAILABLE",
    });
  });

  it("maps 429 to RUNNER_BUSY and keeps a numeric Retry-After", async () => {
    const error = await caught(
      executeOnRunner(env, submission, {
        fetch: fakeFetch(429, { error: "busy" }, { "retry-after": "7" }),
      }),
    );
    expect(error).toMatchObject({
      status: 429,
      code: "RUNNER_BUSY",
      headers: { "Retry-After": "7" },
    });
  });

  it.each([
    [{}],
    [{ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }],
    [{ "retry-after": "99999" }],
  ])("sanitises Retry-After %j to 2 seconds", async (headers) => {
    const error = await caught(
      executeOnRunner(env, submission, { fetch: fakeFetch(429, {}, headers) }),
    );
    expect(error.headers["Retry-After"]).toBe("2");
  });

  it.each([413, 422])(
    "maps %i to 422 INVALID_CODE without forwarding the runner text",
    async (status) => {
      const error = await caught(
        executeOnRunner(env, submission, {
          fetch: fakeFetch(status, {
            error: { code: "X", message: "Judge0 не настроен: задайте JUDGE0_URL" },
          }),
        }),
      );
      expect(error).toMatchObject({ status: 422, code: "INVALID_CODE" });
      expect(error.message).not.toMatch(/Judge0/);
    },
  );

  it.each([
    [500, { error: "Judge0 недоступен: HTTP 500" }],
    [503, "not json"],
    [401, { error: { message: "Неверный RUNNER_TOKEN" } }],
  ])("maps %i to 503 with the generic child-facing message", async (status, body) => {
    const error = await caught(
      executeOnRunner(env, submission, { fetch: fakeFetch(status, body) }),
    );
    expect(error).toMatchObject({
      status: 503,
      code: "RUNNER_UNAVAILABLE",
      message: RUNNER_UNAVAILABLE_MESSAGE,
    });
    expect(errorLog).toHaveBeenCalled();
  });

  it.each([["not json"], [{ output: "no verdict" }], [null]])(
    "rejects an invalid success body %j",
    async (body) => {
      const error = await caught(executeOnRunner(env, submission, { fetch: fakeFetch(200, body) }));
      expect(error).toMatchObject({ status: 503, code: "RUNNER_UNAVAILABLE" });
    },
  );
});
