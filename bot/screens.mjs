// @ts-check
/**
 * Screens: ready-to-send `NewMessageBody` objects (text + inline keyboard).
 * Wording lives in texts.mjs, keyboard limits in keyboard.mjs.
 */

import { callbackButton, inlineKeyboard, openAppButton, startParam } from "./keyboard.mjs";
import * as T from "./texts.mjs";

/** @typedef {import("./keyboard.mjs").AppTarget} AppTarget */
/** @typedef {import("./keyboard.mjs").Button} Button */
/** @typedef {import("./api.mjs").NewMessageBody} NewMessageBody */
/** @typedef {import("./olympiads.mjs").CalendarItem} CalendarItem */
/** @typedef {import("./olympiads.mjs").Olympiad} Olympiad */
/** @typedef {import("./olympiads.mjs").MockTest} MockTest */
/** @typedef {import("./progress.mjs").ProgressSummary} ProgressSummary */

/** Callback payloads of the bot's own buttons. */
export const CALLBACK = /** @type {const} */ ({
  menu: "menu",
  calendar: "calendar",
  progress: "progress",
  how: "how",
  reminders: "reminders",
  remindersOn: "reminders:on",
  remindersOff: "reminders:off",
  /** «Не напоминать» under a reminder: switch off without replacing the reminder text. */
  remindersOffQuiet: "reminders:off:quiet",
});

/**
 * @typedef {object} ScreenContext
 * @property {AppTarget} app
 * @property {boolean} remindersAvailable BOT_REMINDERS=on
 * @property {string} today `YYYY-MM-DD` in Moscow
 */

/**
 * @param {string} text
 * @param {(Button | null | undefined)[][]} rows
 * @returns {NewMessageBody}
 */
function screen(text, rows) {
  const keyboard = inlineKeyboard(rows);
  // `attachments` is always present so that editing a message (POST /answers)
  // replaces the previous keyboard instead of keeping it.
  return { text: T.clampText(text), format: "markdown", attachments: keyboard ? [keyboard] : [] };
}

/** «Меню» – returns the message to the main menu. */
const menuRow = () => [callbackButton(T.BUTTONS.menu, CALLBACK.menu)];

/**
 * @param {ScreenContext} ctx
 * @param {string | null} [openPayload] start parameter for «Открыть Олимпус»
 */
function mainKeyboard(ctx, openPayload) {
  return [
    [openAppButton(T.BUTTONS.openApp, ctx.app, openPayload)],
    [
      callbackButton(T.BUTTONS.calendar, CALLBACK.calendar),
      callbackButton(T.BUTTONS.progress, CALLBACK.progress),
    ],
    [callbackButton(T.BUTTONS.how, CALLBACK.how)],
  ];
}

/**
 * @param {ScreenContext} ctx
 * @param {{ firstName?: string | null, openPayload?: string | null }} p
 */
export function greetingScreen(ctx, { firstName, openPayload }) {
  return screen(T.greetingText({ firstName }), mainKeyboard(ctx, openPayload));
}

/** «Меню»: the main buttons without the greeting. @param {ScreenContext} ctx */
export function menuScreen(ctx) {
  return screen(T.MENU_TEXT, mainKeyboard(ctx));
}

/** @param {ScreenContext} ctx */
export function helpScreen(ctx) {
  return screen(T.helpText(ctx), mainKeyboard(ctx));
}

/** @param {ScreenContext} ctx */
export function unknownScreen(ctx) {
  return screen(T.UNKNOWN_TEXT, mainKeyboard(ctx));
}

/** @param {ScreenContext} ctx */
export function howItWorksScreen(ctx) {
  return screen(T.howItWorksText(ctx), [
    [openAppButton(T.BUTTONS.openApp, ctx.app)],
    ctx.remindersAvailable ? [callbackButton(T.BUTTONS.reminders, CALLBACK.reminders)] : [],
    menuRow(),
  ]);
}

/** @param {ScreenContext} ctx */
export function errorScreen(ctx) {
  return screen(T.ERROR_TEXT, [[openAppButton(T.BUTTONS.openApp, ctx.app)], menuRow()]);
}

/**
 * @param {ScreenContext} ctx
 * @param {{ items: CalendarItem[], grade?: number, region?: string }} p
 */
export function calendarScreen(ctx, { items, grade, region }) {
  const text = T.calendarText({
    today: ctx.today,
    grade,
    region,
    items: items.map(({ olympiad, editions }) => ({ ...olympiad, editions })),
  });
  const eventButtons = items.map(({ olympiad, editions }, i) =>
    openAppButton(
      `${i + 1}. ${T.oneLine(olympiad.title, 60)}`,
      ctx.app,
      // A collapsed series has no single event: open the calendar instead.
      editions > 1 ? "tab_calendar" : (startParam("event", olympiad.id) ?? "tab_calendar"),
    ),
  );
  return screen(text, [
    ...eventButtons.map((b) => [b]),
    [openAppButton(T.BUTTONS.fullCalendar, ctx.app, "tab_calendar")],
    menuRow(),
  ]);
}

/**
 * @param {ScreenContext} ctx
 * @param {ProgressSummary} summary
 */
export function progressScreen(ctx, summary) {
  const empty =
    !summary.stars &&
    !summary.solved.total &&
    !summary.lastMock &&
    !summary.upcoming.length &&
    !summary.expected.length;
  if (empty) {
    return screen(T.NO_PROGRESS_TEXT, [
      [openAppButton(T.BUTTONS.openApp, ctx.app, "tab_training")],
      menuRow(),
    ]);
  }
  return screen(T.progressText({ ...summary, today: ctx.today }), [
    [
      openAppButton(T.BUTTONS.training, ctx.app, "tab_training"),
      openAppButton(T.BUTTONS.myOlympiads, ctx.app, "tab_profile"),
    ],
    ctx.remindersAvailable ? [callbackButton(T.BUTTONS.reminders, CALLBACK.reminders)] : [],
    menuRow(),
  ]);
}

/**
 * @param {ScreenContext} ctx
 * @param {{ enabled: boolean, registrations: number }} p
 */
export function remindersScreen(ctx, { enabled, registrations }) {
  if (!ctx.remindersAvailable) {
    return screen(T.REMINDERS_UNAVAILABLE_TEXT, [
      [openAppButton(T.BUTTONS.myOlympiads, ctx.app, "tab_profile")],
      menuRow(),
    ]);
  }
  return screen(T.remindersText({ enabled, registrations }), [
    [
      enabled
        ? callbackButton(T.BUTTONS.remindersOff, CALLBACK.remindersOff)
        : callbackButton(T.BUTTONS.remindersOn, CALLBACK.remindersOn),
    ],
    registrations ? [] : [openAppButton(T.BUTTONS.fullCalendar, ctx.app, "tab_calendar")],
    menuRow(),
  ]);
}

/**
 * Reminder push. Buttons: a matching mock test (if any), the olympiad card and a quick
 * opt-out.
 * @param {ScreenContext} ctx
 * @param {{ kind: "d3" | "d1", olympiad: Olympiad, mock: MockTest | null }} p
 */
export function reminderScreen(ctx, { kind, olympiad, mock }) {
  const mockPayload = mock ? startParam("mock", mock.id) : null;
  return screen(
    T.reminderText({
      kind,
      title: olympiad.title,
      date: olympiad.date,
      today: ctx.today,
      hasMock: Boolean(mockPayload && ctx.app.webApp),
    }),
    [
      [mockPayload ? openAppButton(T.BUTTONS.openMock, ctx.app, mockPayload) : null],
      [
        openAppButton(
          T.BUTTONS.openEvent,
          ctx.app,
          startParam("event", olympiad.id) ?? "tab_profile",
        ),
      ],
      [callbackButton(T.BUTTONS.remindersStop, CALLBACK.remindersOffQuiet)],
    ],
  );
}
