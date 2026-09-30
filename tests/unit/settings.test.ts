import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import { applySettings, parseSettingsUpdate } from "@/lib/services/settings";

const REGION = "Республика Алтай";

function rejects(input: unknown) {
  let caught: unknown;
  try {
    parseSettingsUpdate(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect(caught).toMatchObject({ status: 422, code: "INVALID_SETTINGS" });
}

describe("parseSettingsUpdate", () => {
  it("accepts a full valid update", () => {
    expect(parseSettingsUpdate({ region: REGION, grade: 5, subject: "info" })).toEqual({
      region: REGION,
      grade: 5,
      subject: "info",
    });
  });

  it("accepts the whole country (empty region) and null to clear fields", () => {
    expect(parseSettingsUpdate({ region: "", grade: null, subject: null })).toEqual({
      region: "",
      grade: null,
      subject: null,
    });
  });

  it("ignores omitted, undefined and unknown fields", () => {
    expect(parseSettingsUpdate({ grade: undefined, theme: "dark", admin: true })).toEqual({});
  });

  it.each([
    [null],
    [[]],
    ["grade=5"],
    [{ region: "Атлантида" }],
    [{ region: "none" }],
    [{ region: 7 }],
    [{ grade: 7 }],
    [{ grade: "5" }],
    [{ subject: "physics" }],
    [{ subject: 1 }],
  ])("rejects %j", (input) => {
    rejects(input);
  });
});

describe("applySettings", () => {
  it("merges an update into the stored settings", () => {
    expect(applySettings({ grade: 4, subject: "math" }, { region: REGION })).toEqual({
      grade: 4,
      subject: "math",
      region: REGION,
    });
  });

  it("null removes a field; starting from nothing works", () => {
    expect(applySettings({ grade: 4, region: REGION }, { grade: null })).toEqual({
      region: REGION,
    });
    expect(applySettings(null, { subject: "info" })).toEqual({ subject: "info" });
  });

  it("drops junk stored under unknown keys or with wrong types", () => {
    const stored = { grade: "4", subject: "math", color: "red" } as unknown as Parameters<
      typeof applySettings
    >[0];
    expect(applySettings(stored, {})).toEqual({ subject: "math" });
  });
});
