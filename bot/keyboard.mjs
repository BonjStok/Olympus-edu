// @ts-check
/**
 * Inline keyboards for MAX messages. Limits come from the Bot API docs:
 * - up to 210 buttons in up to 30 rows, up to 7 buttons per row;
 * - up to 3 per row for `link`, `open_app`, `request_geo_location`, `request_contact`;
 * - button text 1–128 characters; callback payload ≤ 1024;
 * - `open_app.payload` matches `^[\w-]*$` and is ≤ 512 characters.
 */

export const LIMITS = Object.freeze({
  rows: 30,
  buttons: 210,
  perRow: 7,
  widePerRow: 3,
  text: 128,
  callbackPayload: 1024,
  appPayload: 512,
});

const WIDE_TYPES = new Set(["link", "open_app", "request_geo_location", "request_contact"]);

/** Mini-app start parameters understood by the Olympus UI (see `StartParam` in lib/domain/types.ts). */
export const APP_START_PARAM = /^(?:event|topic|mock|tab)_[\w-]+$/;
const OPEN_APP_PAYLOAD = /^[\w-]*$/;

/**
 * @typedef {{ type: "callback", text: string, payload: string }} CallbackButton
 * @typedef {{ type: "open_app", text: string, web_app: string, contact_id?: number, payload?: string }} OpenAppButton
 * @typedef {CallbackButton | OpenAppButton} Button
 * @typedef {{ type: "inline_keyboard", payload: { buttons: Button[][] } }} KeyboardAttachment
 * @typedef {{ webApp: string | null, contactId: number | null }} AppTarget where `open_app` buttons lead
 */

export class KeyboardError extends Error {}

/**
 * Normalises a button caption: one line, 1–128 characters.
 * @param {string} text
 */
export function buttonText(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) throw new KeyboardError("Button text must not be empty");
  return clean.length > LIMITS.text ? clean.slice(0, LIMITS.text - 1).trimEnd() + "…" : clean;
}

/**
 * Builds a mini-app start parameter such as `event_<id>`; null when the result
 * would not be accepted by `open_app.payload`.
 * @param {"event" | "topic" | "mock" | "tab"} kind
 * @param {string} id
 * @returns {string | null}
 */
export function startParam(kind, id) {
  const value = `${kind}_${id}`;
  return value.length <= LIMITS.appPayload && APP_START_PARAM.test(value) ? value : null;
}

/**
 * @param {string} text
 * @param {string} payload
 * @returns {CallbackButton}
 */
export function callbackButton(text, payload) {
  if (!payload || payload.length > LIMITS.callbackPayload)
    throw new KeyboardError("Callback payload must be 1–1024 characters");
  return { type: "callback", text: buttonText(text), payload };
}

/**
 * `open_app` button. Returns null when the bot's public name is unknown, so callers
 * can simply drop the button instead of sending an invalid keyboard.
 * @param {string} text
 * @param {AppTarget} app
 * @param {string | null} [payload] start parameter passed to the mini-app
 * @returns {OpenAppButton | null}
 */
export function openAppButton(text, app, payload) {
  if (!app.webApp) return null;
  /** @type {OpenAppButton} */
  const button = { type: "open_app", text: buttonText(text), web_app: app.webApp };
  if (app.contactId) button.contact_id = app.contactId;
  if (payload) {
    if (payload.length > LIMITS.appPayload || !OPEN_APP_PAYLOAD.test(payload))
      throw new KeyboardError(`Invalid open_app payload: ${payload.slice(0, 40)}`);
    button.payload = payload;
  }
  return button;
}

/**
 * Validates rows against the platform limits and wraps them into an attachment.
 * `null` buttons and empty rows are dropped; returns null when nothing is left.
 * @param {(Button | null | undefined)[][]} rows
 * @returns {KeyboardAttachment | null}
 */
export function inlineKeyboard(rows) {
  const buttons = rows
    .map((row) => row.filter(/** @returns {b is Button} */ (b) => Boolean(b)))
    .filter((row) => row.length > 0);
  if (!buttons.length) return null;
  if (buttons.length > LIMITS.rows) throw new KeyboardError("Too many keyboard rows");
  let total = 0;
  for (const row of buttons) {
    total += row.length;
    const wide = row.some((b) => WIDE_TYPES.has(b.type));
    if (row.length > (wide ? LIMITS.widePerRow : LIMITS.perRow))
      throw new KeyboardError("Too many buttons in a keyboard row");
    for (const b of row) {
      if (!b.text || b.text.length > LIMITS.text)
        throw new KeyboardError("Button text is empty or too long");
    }
  }
  if (total > LIMITS.buttons) throw new KeyboardError("Too many keyboard buttons");
  return { type: "inline_keyboard", payload: { buttons } };
}

/**
 * Splits buttons into rows of at most `perRow`, respecting the stricter limit for
 * wide buttons (open_app / link).
 * @param {(Button | null | undefined)[]} buttons
 * @param {number} perRow
 * @returns {Button[][]}
 */
export function chunkButtons(buttons, perRow) {
  /** @type {Button[][]} */
  const rows = [];
  /** @type {Button[]} */
  let row = [];
  for (const b of buttons) {
    if (!b) continue;
    const limit = Math.min(
      perRow,
      [...row, b].some((x) => WIDE_TYPES.has(x.type)) ? LIMITS.widePerRow : LIMITS.perRow,
    );
    if (row.length >= limit) {
      rows.push(row);
      row = [];
    }
    row.push(b);
  }
  if (row.length) rows.push(row);
  return rows;
}
