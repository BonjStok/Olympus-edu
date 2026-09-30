import { describe, expect, it } from "vitest";
import {
  APP_START_PARAM,
  buttonText,
  callbackButton,
  chunkButtons,
  inlineKeyboard,
  KeyboardError,
  LIMITS,
  openAppButton,
  startParam,
} from "@/bot/keyboard.mjs";

const app = { webApp: "id7700000000_bot", contactId: 12345 };

describe("button text", () => {
  it("collapses whitespace and truncates to 128 characters", () => {
    expect(buttonText("  Ближайшие \n олимпиады ")).toBe("Ближайшие олимпиады");
    const long = buttonText("я".repeat(200));
    expect(long).toHaveLength(128);
    expect(long.endsWith("…")).toBe(true);
  });

  it("rejects empty captions", () => {
    expect(() => buttonText("   ")).toThrow(KeyboardError);
  });
});

describe("open_app buttons", () => {
  it("carries web_app, contact_id and the start payload", () => {
    expect(openAppButton("Открыть", app, "event_vsosh-2026")).toEqual({
      type: "open_app",
      text: "Открыть",
      web_app: "id7700000000_bot",
      contact_id: 12345,
      payload: "event_vsosh-2026",
    });
  });

  it("omits optional fields when unknown", () => {
    expect(openAppButton("Открыть", { webApp: "bot", contactId: null })).toEqual({
      type: "open_app",
      text: "Открыть",
      web_app: "bot",
    });
  });

  it("is dropped when the bot name is unknown", () => {
    expect(openAppButton("Открыть", { webApp: null, contactId: null }, "tab_calendar")).toBeNull();
  });

  it("enforces the payload pattern ^[\\w-]*$ and 512 characters", () => {
    expect(() => openAppButton("x", app, "event_a b")).toThrow(KeyboardError);
    expect(() => openAppButton("x", app, "event_кириллица")).toThrow(KeyboardError);
    expect(() => openAppButton("x", app, "a".repeat(513))).toThrow(KeyboardError);
    expect(openAppButton("x", app, "a".repeat(512))?.payload).toHaveLength(512);
  });
});

describe("start parameters", () => {
  it("builds deep links understood by the mini-app", () => {
    expect(startParam("event", "vsosh-moscow-math-2026-27")).toBe(
      "event_vsosh-moscow-math-2026-27",
    );
    expect(startParam("mock", "mock_5_math")).toBe("mock_mock_5_math");
    expect(startParam("tab", "calendar")).toBe("tab_calendar");
  });

  it("returns null for ids that the platform would reject", () => {
    expect(startParam("event", "bad id")).toBeNull();
    expect(startParam("event", "")).toBeNull();
    expect(startParam("event", "x".repeat(600))).toBeNull();
  });

  it("recognises app start parameters", () => {
    expect(APP_START_PARAM.test("event_abc")).toBe(true);
    expect(APP_START_PARAM.test("tab_profile")).toBe(true);
    expect(APP_START_PARAM.test("calendar")).toBe(false);
    expect(APP_START_PARAM.test("event_")).toBe(false);
  });
});

describe("callback buttons", () => {
  it("validates the payload length", () => {
    expect(callbackButton("Меню", "menu")).toEqual({
      type: "callback",
      text: "Меню",
      payload: "menu",
    });
    expect(() => callbackButton("x", "")).toThrow(KeyboardError);
    expect(() => callbackButton("x", "p".repeat(1025))).toThrow(KeyboardError);
  });
});

describe("keyboard limits", () => {
  const cb = (i: number) => callbackButton(`b${i}`, `p${i}`);
  const open = (i: number) => openAppButton(`o${i}`, app, `tab_calendar`);

  it("wraps rows into an inline_keyboard attachment and drops empty rows/buttons", () => {
    expect(inlineKeyboard([[cb(1), null], [], [undefined]])).toEqual({
      type: "inline_keyboard",
      payload: { buttons: [[cb(1)]] },
    });
    expect(inlineKeyboard([[null]])).toBeNull();
  });

  it("allows 7 callback buttons per row but only 3 open_app buttons", () => {
    expect(() => inlineKeyboard([Array.from({ length: 7 }, (_, i) => cb(i))])).not.toThrow();
    expect(() => inlineKeyboard([Array.from({ length: 8 }, (_, i) => cb(i))])).toThrow(
      KeyboardError,
    );
    expect(() => inlineKeyboard([[open(1), open(2), open(3)]])).not.toThrow();
    expect(() => inlineKeyboard([[open(1), open(2), open(3), open(4)]])).toThrow(KeyboardError);
    expect(() => inlineKeyboard([[open(1), cb(1), cb(2), cb(3)]])).toThrow(KeyboardError);
  });

  it("allows at most 30 rows and 210 buttons", () => {
    const rows = Array.from({ length: 30 }, (_, r) =>
      Array.from({ length: 7 }, (_, i) => cb(r * 7 + i)),
    );
    expect(() => inlineKeyboard(rows)).not.toThrow();
    expect(() => inlineKeyboard([...rows, [cb(999)]])).toThrow(KeyboardError);
    expect(LIMITS.buttons).toBe(210);
  });

  it("chunks buttons respecting the stricter limit for open_app", () => {
    const opens = Array.from({ length: 7 }, (_, i) => open(i));
    expect(chunkButtons(opens, 7).map((r) => r.length)).toEqual([3, 3, 1]);
    const callbacks = Array.from({ length: 9 }, (_, i) => cb(i));
    expect(chunkButtons(callbacks, 7).map((r) => r.length)).toEqual([7, 2]);
    expect(chunkButtons([cb(1), cb(2), open(1), open(2)], 4).map((r) => r.length)).toEqual([3, 1]);
    for (const row of chunkButtons([...opens, ...callbacks], 7)) {
      expect(() => inlineKeyboard([row])).not.toThrow();
    }
  });
});
