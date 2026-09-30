import { describe, expect, it } from "vitest";
import {
  ADMIN_HOME,
  fromHash,
  INITIAL_NAV,
  makeStartParam,
  navReducer,
  parentOf,
  parseStartParam,
  toHash,
  type NavState,
} from "@/lib/ui/navigation";

describe("navigation state", () => {
  it("round-trips every screen through the URL hash", () => {
    const states: NavState[] = [
      INITIAL_NAV,
      { tab: "calendar", stack: [{ name: "event", id: "vsosh-msk-math" }] },
      { tab: "learn", stack: [{ name: "topic", id: "math-4-01", part: "practice", step: 2 }] },
      { tab: "mocks", stack: [{ name: "attempt", id: "0b7e-uuid" }] },
      { tab: "profile", stack: [{ name: "legal", doc: "privacy" }] },
      ADMIN_HOME,
      {
        tab: "admin",
        stack: [
          { name: "admin", kind: "tasks" },
          { name: "admin-edit", kind: "tasks", id: "new" },
        ],
      },
    ];
    for (const s of states) expect(fromHash(toHash(s))).toEqual(s);
    expect(
      toHash({ tab: "learn", stack: [{ name: "topic", id: "t", part: "theory", step: 0 }] }),
    ).toBe("#/learn/topic/t/theory/1");
  });

  it("ignores MAX launch parameters and unknown hashes", () => {
    expect(fromHash("#WebAppData=query_id%3D1&WebAppPlatform=web")).toBeNull();
    expect(fromHash("")).toBeNull();
    expect(fromHash("#/nowhere")).toBeNull();
  });

  it("maps old «Теория»/«Тренировки» links to «Учёба»", () => {
    expect(fromHash("#/knowledge/topic/math-4-01/3")).toEqual({
      tab: "learn",
      stack: [{ name: "topic", id: "math-4-01", part: "theory", step: 2 }],
    });
    expect(fromHash("#/training/topic/math-4-01/1")?.stack[0]).toMatchObject({ part: "practice" });
    expect(fromHash("#/training")).toEqual({ tab: "learn", stack: [] });
  });

  it("stops at a broken segment", () => {
    expect(fromHash("#/calendar/event")).toEqual({ tab: "calendar", stack: [] });
    expect(fromHash("#/profile/legal/secret")).toEqual({ tab: "profile", stack: [] });
    expect(fromHash("#/admin")).toEqual(ADMIN_HOME);
  });

  it("reduces actions", () => {
    let s = navReducer(INITIAL_NAV, { type: "tab", tab: "calendar" });
    s = navReducer(s, { type: "push", screen: { name: "event", id: "a" } });
    s = navReducer(s, { type: "replace", screen: { name: "event", id: "b" } });
    expect(s).toEqual({ tab: "calendar", stack: [{ name: "event", id: "b" }] });
    expect(navReducer(s, { type: "pop" })).toEqual({ tab: "calendar", stack: [] });
    expect(navReducer(s, { type: "tab", tab: "admin" })).toEqual(ADMIN_HOME);
  });

  it("knows where Back leads", () => {
    expect(parentOf(INITIAL_NAV)).toBeNull();
    expect(parentOf({ tab: "calendar", stack: [{ name: "event", id: "a" }] })).toEqual({
      tab: "calendar",
      stack: [],
    });
    expect(parentOf(ADMIN_HOME)).toEqual({ tab: "profile", stack: [] });
  });
});

describe("start_param deep links", () => {
  it("parses the documented payloads", () => {
    expect(parseStartParam("event_vsosh-msk-math")).toEqual({
      type: "event",
      id: "vsosh-msk-math",
    });
    expect(parseStartParam("topic_math-4-01")).toEqual({ type: "topic", id: "math-4-01" });
    expect(parseStartParam("mock_mock-4-math")).toEqual({ type: "mock", id: "mock-4-math" });
    expect(parseStartParam("tab_calendar")).toEqual({ type: "tab", tab: "calendar" });
    expect(parseStartParam("tab_knowledge")).toEqual({ type: "tab", tab: "learn" });
    expect(parseStartParam("tab_training")).toEqual({ type: "tab", tab: "learn" });
  });

  it("rejects anything else", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "tab_admin",
      "event_",
      "event_a b",
      "hello",
      "event_<script>",
    ])
      expect(parseStartParam(bad)).toBeNull();
  });

  it("builds payloads", () => {
    expect(makeStartParam({ type: "mock", id: "m1" })).toBe("mock_m1");
    expect(makeStartParam({ type: "tab", tab: "profile" })).toBe("tab_profile");
  });
});
