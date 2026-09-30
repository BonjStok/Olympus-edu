// @ts-check
/**
 * Update routing: MAX `Update` objects → replies.
 *
 * Handled update types (Bot API schema):
 * - bot_started   → greeting (+ a section for a `?start=<payload>` deep link);
 * - bot_stopped, bot_removed, dialog_removed → the user is marked stopped;
 * - message_created (dialogs only) → commands /start /help /calendar /progress /reminders;
 * - message_callback → our inline buttons; always acknowledged with POST /answers.
 * Replies are answers to the user's own actions, which MAX rules allow.
 */

import { APP_START_PARAM } from "./keyboard.mjs";
import { errorFields } from "./log.mjs";
import { selectUpcoming } from "./olympiads.mjs";
import { parseSettings, registeredOlympiadIds, summarizeProgress } from "./progress.mjs";
import * as S from "./screens.mjs";
import { FAILURE_NOTICE, REMINDERS_OFF_NOTICE, REMINDERS_ON_NOTICE } from "./texts.mjs";
import { moscowToday } from "./time.mjs";

/** @typedef {import("./api.mjs").MaxApi} MaxApi */
/** @typedef {import("./api.mjs").NewMessageBody} NewMessageBody */
/** @typedef {import("./store.mjs").Store} Store */
/** @typedef {import("./log.mjs").Logger} Logger */
/** @typedef {import("./keyboard.mjs").AppTarget} AppTarget */
/** @typedef {import("./screens.mjs").ScreenContext} ScreenContext */

/**
 * The subset of the `Update` schema the bot reads.
 * @typedef {{ user_id?: number | string, first_name?: string, is_bot?: boolean }} MaxUser
 * @typedef {object} MaxUpdate
 * @property {string} update_type
 * @property {number} [timestamp]
 * @property {number | string} [chat_id]
 * @property {MaxUser} [user]
 * @property {string | null} [payload] bot_started deep-link payload
 * @property {{ sender?: MaxUser | null, recipient?: { chat_type?: string, chat_id?: number | null }, body?: { mid?: string, text?: string | null } } | null} [message]
 * @property {{ callback_id?: string, payload?: string, user?: MaxUser }} [callback]
 */

/** Commands registered with PATCH /me/commands (names without the slash, as in the SDK). */
export const COMMANDS = [
  { name: "start", description: "Начать и открыть меню" },
  { name: "calendar", description: "Ближайшие олимпиады" },
  { name: "progress", description: "Мой прогресс и «Мои олимпиады»" },
  { name: "reminders", description: "Напоминания об олимпиадах" },
  { name: "help", description: "Что умеет бот" },
];

/** Plain-text shortcuts for children who type instead of tapping. */
const ALIASES = new Map([
  ["меню", "start"],
  ["старт", "start"],
  ["начать", "start"],
  ["привет", "start"],
  ["календарь", "calendar"],
  ["олимпиады", "calendar"],
  ["ближайшие олимпиады", "calendar"],
  ["прогресс", "progress"],
  ["мой прогресс", "progress"],
  ["напоминания", "reminders"],
  ["помощь", "help"],
  ["помоги", "help"],
  ["как это работает", "how"],
]);

/** Sections reachable by command. */
const SECTIONS = new Set(["calendar", "progress", "reminders", "help", "how"]);
/** `?start=<payload>` values that open a section right after the greeting. */
const START_SECTIONS = new Set(["calendar", "progress", "reminders", "help"]);

/**
 * `/calendar`, `/Calendar@olympus_bot`, «календарь» → { command: "calendar" }.
 * Returns null for ordinary text.
 * @param {unknown} text
 * @returns {{ command: string, args: string } | null}
 */
export function parseCommand(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (t.startsWith("/")) {
    const match = /^\/([A-Za-z0-9_]{1,64})(?:@[\w.-]+)?(?:\s+([\s\S]*))?$/.exec(t);
    return match
      ? { command: match[1].toLowerCase(), args: (match[2] ?? "").trim() }
      : { command: "", args: "" };
  }
  const normalized = t
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[!.?…]+$/u, "")
    .trim();
  const alias = ALIASES.get(normalized);
  return alias ? { command: alias, args: "" } : null;
}

/**
 * Stable identity of an update for de-duplication (webhook retries, polling replays).
 * The schema has no update id, so message/callback ids are used where they exist.
 * @param {MaxUpdate} u
 */
export function updateKey(u) {
  if (u.update_type === "message_created" && u.message?.body?.mid)
    return `message:${u.message.body.mid}`;
  if (u.update_type === "message_callback" && u.callback?.callback_id)
    return `callback:${u.callback.callback_id}`;
  return `${u.update_type}:${u.chat_id ?? ""}:${userOf(u)?.user_id ?? ""}:${u.timestamp ?? ""}`;
}

/**
 * The user an update is about.
 * @param {MaxUpdate} u
 * @returns {MaxUser | undefined}
 */
export function userOf(u) {
  return u.user ?? u.callback?.user ?? u.message?.sender ?? undefined;
}

/**
 * @param {unknown} payload
 * @returns {string | null}
 */
function appStartParam(payload) {
  const value = typeof payload === "string" ? payload.trim() : "";
  return value.length <= 512 && APP_START_PARAM.test(value) ? value : null;
}

/**
 * @param {{
 *   api: MaxApi,
 *   store: Store,
 *   logger: Logger,
 *   app: () => AppTarget,
 *   remindersAvailable: boolean,
 *   now: () => number,
 * }} deps
 */
export function createRouter({ api, store, logger, app, remindersAvailable, now }) {
  /** @returns {ScreenContext} */
  const ctx = () => ({ app: app(), remindersAvailable, today: moscowToday(now()) });

  /**
   * Sends a message; a 403 means the user blocked the bot → remember that.
   * @param {string} userId
   * @param {NewMessageBody} body
   */
  async function send(userId, body) {
    try {
      await api.sendMessage({ userId }, body);
    } catch (error) {
      if (/** @type {any} */ (error)?.status === 403) {
        logger.warn("send_forbidden", { userId, ...errorFields(error) });
        await store.markStopped(userId).catch(() => {});
        return;
      }
      throw error;
    }
  }

  /**
   * Bookkeeping must not prevent the reply.
   * @param {string} userId
   * @param {string | null} firstName
   * @param {boolean} started
   */
  async function remember(userId, firstName, started) {
    try {
      if (started) await store.startUser(userId, firstName);
      else await store.touchUser(userId, firstName);
    } catch (error) {
      logger.error("user_upsert_failed", { userId, ...errorFields(error) });
    }
  }

  /**
   * Renders a data screen; database problems turn into a friendly error screen.
   * @param {string} name calendar | progress | reminders | how | help
   * @param {string} userId
   * @returns {Promise<NewMessageBody>}
   */
  async function section(name, userId) {
    const c = ctx();
    try {
      if (name === "calendar") {
        const [rows, olympiads] = await Promise.all([
          store.loadProgress(userId),
          store.loadOlympiads(),
        ]);
        const settings = parseSettings(rows.find((r) => r.key === "settings")?.data);
        const { items } = selectUpcoming(olympiads, {
          today: c.today,
          region: settings.region,
          grade: settings.grade,
          limit: 5,
        });
        return S.calendarScreen(c, { items, grade: settings.grade, region: settings.region });
      }
      if (name === "progress") {
        const [rows, olympiads] = await Promise.all([
          store.loadProgress(userId),
          store.loadOlympiads(),
        ]);
        const byId = new Map(olympiads.map((o) => [o.id, o]));
        return S.progressScreen(c, summarizeProgress(rows, byId, c.today));
      }
      if (name === "reminders") {
        if (!remindersAvailable) return S.remindersScreen(c, { enabled: false, registrations: 0 });
        const [user, rows] = await Promise.all([store.getUser(userId), store.loadProgress(userId)]);
        return S.remindersScreen(c, {
          enabled: Boolean(user?.remindersEnabled && !user.stoppedAt),
          registrations: registeredOlympiadIds(rows).length,
        });
      }
      if (name === "how") return S.howItWorksScreen(c);
      if (name === "help") return S.helpScreen(c);
    } catch (error) {
      logger.error("section_failed", { section: name, userId, ...errorFields(error) });
      return S.errorScreen(c);
    }
    return S.unknownScreen(c);
  }

  /** @param {MaxUpdate} u */
  async function onStarted(u) {
    const user = u.user;
    if (!user?.user_id || user.is_bot) return;
    const userId = String(user.user_id);
    const firstName = user.first_name ?? null;
    await remember(userId, firstName, true);
    const payload = typeof u.payload === "string" ? u.payload.trim() : "";
    const openPayload = appStartParam(payload);
    logger.info("bot_started", {
      userId,
      payload: openPayload
        ? payload.split("_")[0]
        : START_SECTIONS.has(payload)
          ? payload
          : payload
            ? "other"
            : "none",
    });
    await send(userId, S.greetingScreen(ctx(), { firstName, openPayload }));
    if (START_SECTIONS.has(payload)) await send(userId, await section(payload, userId));
  }

  /** @param {MaxUpdate} u */
  async function onStopped(u) {
    const userId = u.user?.user_id;
    if (!userId) return;
    await store.markStopped(String(userId));
    logger.info("bot_stopped", { userId: String(userId), updateType: u.update_type });
  }

  /** @param {MaxUpdate} u */
  async function onMessage(u) {
    const sender = u.message?.sender;
    if (!sender?.user_id || sender.is_bot) return;
    const chatType = u.message?.recipient?.chat_type;
    if (chatType && chatType !== "dialog") return; // the bot works in private dialogs only
    const userId = String(sender.user_id);
    const firstName = sender.first_name ?? null;
    await remember(userId, firstName, false);
    const parsed = parseCommand(u.message?.body?.text);
    const command = parsed?.command ?? "";
    const known = command === "start" || SECTIONS.has(command);
    // Only known command names are logged: free text is never written to the logs.
    logger.info("message", { userId, command: known ? command : parsed ? "unknown" : "text" });
    /** @type {NewMessageBody} */
    let body;
    if (command === "start") {
      body = S.greetingScreen(ctx(), { firstName, openPayload: appStartParam(parsed?.args) });
    } else if (SECTIONS.has(command)) {
      body = await section(command, userId);
    } else {
      body = S.unknownScreen(ctx());
    }
    await send(userId, body);
  }

  /**
   * Acknowledges a callback by replacing the pressed message; falls back to a new
   * message when the original one cannot be edited.
   * @param {MaxUpdate} u
   * @param {string} userId
   * @param {{ message?: NewMessageBody, notification?: string }} answer
   */
  async function respond(u, userId, answer) {
    const callbackId = String(u.callback?.callback_id);
    const chatKey = `user:${userId}`;
    if (answer.message && !u.message) {
      await send(userId, answer.message);
      await api.answerCallback(
        callbackId,
        { notification: answer.notification ?? "Готово" },
        chatKey,
      );
      return;
    }
    try {
      await api.answerCallback(callbackId, answer, chatKey);
    } catch (error) {
      const status = /** @type {any} */ (error)?.status;
      if (!answer.message || status === 403 || status === 401 || status === 0 || status >= 500)
        throw error;
      logger.warn("callback_edit_failed", { userId, ...errorFields(error) });
      await send(userId, answer.message);
    }
  }

  /** @param {MaxUpdate} u */
  async function onCallback(u) {
    const cb = u.callback;
    if (!cb?.callback_id || !cb.user?.user_id) return;
    const userId = String(cb.user.user_id);
    const firstName = cb.user.first_name ?? null;
    await remember(userId, firstName, false);
    const payload = String(cb.payload ?? "");
    logger.info("callback", { userId, payload: payload.slice(0, 32) });
    const c = ctx();

    switch (payload) {
      case S.CALLBACK.calendar:
      case S.CALLBACK.progress:
      case S.CALLBACK.how:
      case S.CALLBACK.reminders:
        return respond(u, userId, { message: await section(payload, userId) });
      case S.CALLBACK.remindersOn:
      case S.CALLBACK.remindersOff: {
        if (!remindersAvailable)
          return respond(u, userId, { message: await section("reminders", userId) });
        const enabled = payload === S.CALLBACK.remindersOn;
        try {
          const [user, rows] = await Promise.all([
            store.setReminders(userId, enabled),
            store.loadProgress(userId),
          ]);
          logger.info("reminders_changed", { userId, enabled: user.remindersEnabled });
          return respond(u, userId, {
            message: S.remindersScreen(c, {
              enabled: user.remindersEnabled,
              registrations: registeredOlympiadIds(rows).length,
            }),
            notification: enabled ? REMINDERS_ON_NOTICE : REMINDERS_OFF_NOTICE,
          });
        } catch (error) {
          logger.error("reminders_change_failed", { userId, ...errorFields(error) });
          return respond(u, userId, { message: S.errorScreen(c) });
        }
      }
      case S.CALLBACK.remindersOffQuiet: {
        try {
          await store.setReminders(userId, false);
        } catch (error) {
          logger.error("reminders_change_failed", { userId, ...errorFields(error) });
          return respond(u, userId, { notification: FAILURE_NOTICE });
        }
        logger.info("reminders_changed", { userId, enabled: false });
        return respond(u, userId, { notification: REMINDERS_OFF_NOTICE });
      }
      case S.CALLBACK.menu:
      default:
        // Also covers buttons of older bot versions: show the menu again.
        return respond(u, userId, { message: S.menuScreen(c) });
    }
  }

  return {
    /**
     * Handles one update. Errors are logged, never thrown (one bad update must not
     * stop the queue).
     * @param {MaxUpdate} u
     */
    async handle(u) {
      try {
        switch (u?.update_type) {
          case "bot_started":
            return await onStarted(u);
          case "bot_stopped":
          case "bot_removed":
          case "dialog_removed":
            return await onStopped(u);
          case "message_created":
            return await onMessage(u);
          case "message_callback":
            return await onCallback(u);
          default:
            logger.debug("update_ignored", { updateType: u?.update_type });
        }
      } catch (error) {
        logger.error("update_failed", {
          updateType: u?.update_type,
          userId: userOf(u)?.user_id,
          ...errorFields(error),
        });
      }
    },
  };
}

/** @typedef {ReturnType<typeof createRouter>} Router */
