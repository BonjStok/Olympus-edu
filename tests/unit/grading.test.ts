import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import {
  INVALID_NUMBER_MESSAGE,
  isCorrectNumber,
  parseNumberAnswer,
  requireNumberAnswer,
  taskPoints,
} from "@/lib/services/grading";

describe("parseNumberAnswer", () => {
  it.each([
    ["12", 12],
    [" 12 ", 12],
    ["1,5", 1.5],
    ["1.5", 1.5],
    ["+3", 3],
    ["-0.5", -0.5],
    ["-0,25", -0.25],
    ["007", 7],
    [42, 42],
    [-1.25, -1.25],
  ])("%j → %s", (raw, expected) => {
    expect(parseNumberAnswer(raw)).toBe(expected);
  });

  it.each([
    ["abc"],
    [""],
    ["   "],
    ["1e3"],
    ["1.2.3"],
    ["1,"],
    [",5"],
    ["1 000"],
    ["--1"],
    ["0x10"],
    ["1".repeat(101)],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [undefined],
    [true],
    [{ value: 1 }],
  ])("%j is not a number answer", (raw) => {
    expect(parseNumberAnswer(raw)).toBeNull();
  });
});

describe("isCorrectNumber", () => {
  it.each([
    ["1,5", "1.5", true],
    ["1.50", "1,5", true],
    ["+3", "3", true],
    ["-0", "0", true],
    ["4", "3", false],
    ["abc", "3", false],
    ["3", "not a number", false],
    ["3", undefined, false],
  ])("answer %j vs reference %j → %s", (raw, answer, expected) => {
    expect(isCorrectNumber({ answer }, raw)).toBe(expected);
  });
});

describe("requireNumberAnswer", () => {
  it("returns the parsed number", () => {
    expect(requireNumberAnswer("2,5")).toBe(2.5);
  });

  it("throws 422 INVALID_ANSWER with a human message", () => {
    let caught: unknown;
    try {
      requireNumberAnswer("двенадцать");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 422,
      code: "INVALID_ANSWER",
      message: INVALID_NUMBER_MESSAGE,
    });
  });
});

describe("taskPoints", () => {
  it.each([
    [undefined, 1],
    [3, 3],
    [0, 0],
    [-2, 1],
    [Number.NaN, 1],
  ])("points %s → %s", (points, expected) => {
    expect(taskPoints({ points })).toBe(expected);
  });
});
