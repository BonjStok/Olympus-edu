import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import {
  applyAnswerPatch,
  INPUT_LIMITS,
  isCodeLanguage,
  isPlainObject,
  isValidId,
  parseMockAnswers,
  requireBoolean,
  requireCode,
  requireCodeSubmission,
  requireId,
  requireLanguage,
} from "@/lib/server/validate";

function thrown(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected an ApiError");
}

describe("ids", () => {
  it.each([
    ["math-4-01-task-1", true],
    ["0b3c5d0e-1111-2222-3333-444455556666", true],
    ["A_b-9", true],
    ["a".repeat(100), true],
    ["a".repeat(101), false],
    ["", false],
    ["../etc", false],
    ["id with space", false],
    ["ид", false],
    [42, false],
  ])("isValidId(%j) → %s", (value, expected) => {
    expect(isValidId(value)).toBe(expected);
  });

  it("requireId distinguishes a missing id from a malformed one (400 INVALID_ID)", () => {
    expect(requireId("t1")).toBe("t1");
    for (const value of [undefined, null, ""]) {
      const error = thrown(() => requireId(value, "taskId"));
      expect(error).toMatchObject({ status: 400, code: "INVALID_ID" });
      expect(error.message).toMatch(/Не указан taskId/);
    }
    expect(thrown(() => requireId("a/b")).message).toMatch(/Некорректный id/);
    expect(thrown(() => requireId({ $gt: "" })).code).toBe("INVALID_ID");
  });
});

describe("scalar validators", () => {
  it("requireBoolean", () => {
    expect(requireBoolean(false, "INVALID_SELF_CHECK", "m")).toBe(false);
    expect(thrown(() => requireBoolean("true", "INVALID_SELF_CHECK", "m"))).toMatchObject({
      status: 422,
      code: "INVALID_SELF_CHECK",
    });
  });

  it("languages", () => {
    for (const language of ["python", "cpp", "java", "javascript", "kotlin", "pascal"]) {
      expect(isCodeLanguage(language)).toBe(true);
      expect(requireLanguage(language)).toBe(language);
    }
    expect(isCodeLanguage("ruby")).toBe(false);
    expect(thrown(() => requireLanguage("PYTHON"))).toMatchObject({
      status: 422,
      code: "INVALID_LANGUAGE",
    });
  });

  it("code up to 50 000 characters", () => {
    expect(requireCode("")).toBe("");
    expect(requireCode("x".repeat(INPUT_LIMITS.code))).toHaveLength(50_000);
    expect(thrown(() => requireCode("x".repeat(INPUT_LIMITS.code + 1)))).toMatchObject({
      status: 422,
      code: "INVALID_CODE",
    });
    expect(thrown(() => requireCode(123)).code).toBe("INVALID_CODE");
    expect(requireCodeSubmission({ code: "print(1)", language: "python", extra: 1 })).toEqual({
      code: "print(1)",
      language: "python",
    });
  });

  it("isPlainObject", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});

describe("mock answers", () => {
  const ids = ["t1", "t2", "t3"];

  it("builds a patch: text, code, and null/'' for removal", () => {
    expect(
      parseMockAnswers(
        { t1: "12", t2: { code: "print(1)", language: "python", junk: true }, t3: "" },
        ids,
      ),
    ).toEqual({ t1: "12", t2: { code: "print(1)", language: "python" }, t3: null });
    expect(parseMockAnswers({ t1: null }, ids)).toEqual({ t1: null });
    expect(parseMockAnswers({}, ids)).toEqual({});
  });

  it.each([
    [null],
    [[]],
    ["t1=12"],
    [{ t9: "1" }],
    [JSON.parse('{"__proto__": {"t1": "1"}, "t1": "1"}')],
    [{ t1: "x".repeat(INPUT_LIMITS.textAnswer + 1) }],
    [{ t1: 12 }],
    [{ t1: true }],
    [{ t1: { code: 5, language: "python" } }],
    [{ t1: { code: "x".repeat(INPUT_LIMITS.code + 1), language: "python" } }],
    [{ t1: { code: "x", language: "brainfuck" } }],
    [{ t1: ["12"] }],
  ])("rejects %j with 422 INVALID_ANSWERS", (value) => {
    expect(thrown(() => parseMockAnswers(value, ids))).toMatchObject({
      status: 422,
      code: "INVALID_ANSWERS",
    });
  });

  it("lenient mode (/api/v1) ignores other tasks and takes numbers as text", () => {
    expect(
      parseMockAnswers({ t9: "1", t1: 12, t2: "", __proto__x: 1 }, ids, { mode: "lenient" }),
    ).toEqual({ t1: "12", t2: null });
    expect(
      parseMockAnswers(JSON.parse('{"__proto__": {"t1": "1"}}'), ids, { mode: "lenient" }),
    ).toEqual({});
    // Values of the attempt's own tasks are still validated.
    expect(thrown(() => parseMockAnswers({ t1: true }, ids, { mode: "lenient" }))).toMatchObject({
      status: 422,
      code: "INVALID_ANSWERS",
    });
    expect(
      thrown(() => parseMockAnswers({ t1: Number.NaN }, ids, { mode: "lenient" })),
    ).toMatchObject({ status: 422, code: "INVALID_ANSWERS" });
  });

  it("accepts a text answer of exactly 2 000 characters", () => {
    expect(parseMockAnswers({ t1: "1".repeat(INPUT_LIMITS.textAnswer) }, ids).t1).toHaveLength(
      2000,
    );
  });

  it("applies a patch without touching other answers", () => {
    const current = { t1: "1", t2: "2" };
    expect(applyAnswerPatch(current, { t2: null, t3: "3" })).toEqual({ t1: "1", t3: "3" });
    expect(current).toEqual({ t1: "1", t2: "2" });
  });
});
