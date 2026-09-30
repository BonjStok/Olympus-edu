import { describe, expect, it } from "vitest";
import { createRouter, parseCommand, updateKey, userOf, COMMANDS } from "@/bot/router.mjs";
import { MaxApiError } from "@/bot/api.mjs";
import { buttonsOf, fakeApi, memoryLogger, memoryStore, NOW, olympiad } from "./helpers";

function setup(options: { reminders?: boolean; webApp?: string | null } = {}) {
  const store = memoryStore({
    olympiads: [
      olympiad({ id: "near", date: "2026-10-05", title: "Ближняя" }),
      olympiad({ id: "moscow", date: "2026-10-06", title: "Московская", region: "Москва" }),
    ],
    progress: {
      "max:42": {
        settings: { region: "Москва", grade: 5 },
        "registration:near": { registered: true },
        "task:1": { subject: "math", correct: true },
      },
    },
  });
  const api = fakeApi();
  const { logger, lines } = memoryLogger();
  const router = createRouter({
    api,
    store,
    logger,
    app: () => ({
      webApp: options.webApp === undefined ? "olympus_bot" : options.webApp,
      contactId: 999,
    }),
    remindersAvailable: options.reminders ?? false,
    now: () => NOW,
  });
  return { store, api, router, lines };
}

const user = { user_id: 42, first_name: "Маша", is_bot: false };
const message = (text: string, extra: Record<string, unknown> = {}) => ({
  update_type: "message_created",
  timestamp: NOW,
  message: {
    sender: user,
    recipient: { chat_type: "dialog", chat_id: 5000 },
    body: { mid: `mid-${text}`, text },
    ...extra,
  },
});
const callback = (payload: string, withMessage = true) => ({
  update_type: "message_callback",
  timestamp: NOW,
  callback: { callback_id: `cb-${payload}`, payload, user },
  message: withMessage ? { recipient: { chat_type: "dialog" }, body: { mid: "m" } } : null,
});

describe("command parsing", () => {
  it.each([
    ["/start", "start", ""],
    ["/calendar", "calendar", ""],
    ["  /Progress  ", "progress", ""],
    ["/start@id7700000000_bot event_x", "start", "event_x"],
    ["/help me please", "help", "me please"],
    ["Календарь", "calendar", ""],
    ["мой прогресс!", "progress", ""],
    ["Напоминания", "reminders", ""],
    ["Как это работает?", "how", ""],
    ["/unknown", "unknown", ""],
    ["/", "", ""],
  ])("%j → %s", (text, command, args) => {
    expect(parseCommand(text)).toEqual({ command, args });
  });

  it("returns null for ordinary text", () => {
    expect(parseCommand("привет, как дела?")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it("registers commands in the schema format (name ≤ 64, description ≤ 128, no slash)", () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z]{1,64}$/);
      expect(c.description.length).toBeLessThanOrEqual(128);
    }
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "start",
      "calendar",
      "progress",
      "reminders",
      "help",
    ]);
  });
});

describe("update identity", () => {
  it("uses message and callback ids where the schema has them", () => {
    expect(updateKey(message("/start"))).toBe("message:mid-/start");
    expect(updateKey(callback("menu"))).toBe("callback:cb-menu");
    expect(
      updateKey({ update_type: "bot_started", chat_id: 1, user: { user_id: 2 }, timestamp: 3 }),
    ).toBe("bot_started:1:2:3");
  });

  it("finds the user of any update", () => {
    expect(userOf(message("x"))?.user_id).toBe(42);
    expect(userOf(callback("x"))?.user_id).toBe(42);
    expect(userOf({ update_type: "bot_stopped", user: { user_id: 7 } })?.user_id).toBe(7);
  });
});

describe("bot_started", () => {
  it("greets the user with the app button and menu, and remembers them", async () => {
    const { router, api, store } = setup();
    await router.handle({ update_type: "bot_started", chat_id: 5000, user, timestamp: NOW });
    expect(api.sent).toHaveLength(1);
    const { to, body } = api.sent[0];
    expect(to).toEqual({ userId: "42" });
    expect(body.text).toContain("Привет, Маша!");
    expect(buttonsOf(body)).toEqual([
      { type: "open_app", text: "Открыть Олимпус", web_app: "olympus_bot", contact_id: 999 },
      { type: "callback", text: "Ближайшие олимпиады", payload: "calendar" },
      { type: "callback", text: "Мой прогресс", payload: "progress" },
      { type: "callback", text: "Как это работает", payload: "how" },
    ]);
    expect(store.users.get("42")).toMatchObject({ firstName: "Маша", stoppedAt: null });
  });

  it("passes an app deep link from ?start= to the mini-app button", async () => {
    const { router, api } = setup();
    await router.handle({ update_type: "bot_started", user, payload: "event_vsosh-2026" });
    expect(buttonsOf(api.sent[0].body)[0]).toMatchObject({ payload: "event_vsosh-2026" });
  });

  it("opens a section for ?start=calendar after the greeting", async () => {
    const { router, api } = setup();
    await router.handle({ update_type: "bot_started", user, payload: "calendar" });
    expect(api.sent).toHaveLength(2);
    expect(api.sent[1].body.text).toContain("Ближайшие олимпиады");
  });

  it("ignores unsafe payloads", async () => {
    const { router, api } = setup();
    await router.handle({ update_type: "bot_started", user, payload: "event_<script>" });
    expect(buttonsOf(api.sent[0].body)[0]).not.toHaveProperty("payload");
    expect(api.sent).toHaveLength(1);
  });

  it("works without a known bot name (no open_app buttons)", async () => {
    const { router, api } = setup({ webApp: null });
    await router.handle({ update_type: "bot_started", user });
    expect(buttonsOf(api.sent[0].body).every((b) => b.type === "callback")).toBe(true);
  });

  it("still greets when the database is down", async () => {
    const { router, api, store, lines } = setup();
    store.startUser = async () => {
      throw new Error("db down");
    };
    await router.handle({ update_type: "bot_started", user });
    expect(api.sent).toHaveLength(1);
    expect(lines.some((l) => l.msg === "user_upsert_failed")).toBe(true);
  });
});

describe("stop events", () => {
  it.each(["bot_stopped", "bot_removed", "dialog_removed"])(
    "%s marks the user stopped, switches reminders off and sends nothing",
    async (type) => {
      const { router, api, store } = setup({ reminders: true });
      await store.setReminders("42", true);
      await router.handle({ update_type: type, chat_id: 5000, user, timestamp: NOW });
      expect(store.users.get("42")).toMatchObject({ remindersEnabled: false });
      expect(store.users.get("42")?.stoppedAt).toBe(NOW);
      expect(api.sent).toHaveLength(0);
    },
  );
});

describe("commands", () => {
  it("/calendar uses the user's region and grade from the app settings", async () => {
    const { router, api } = setup();
    await router.handle(message("/calendar"));
    const body = api.sent[0].body;
    expect(body.text).toContain("5 класс · Москва и вся Россия");
    expect(body.text).toContain("Ближняя");
    expect(body.text).toContain("Московская");
    const payloads = buttonsOf(body).map((b) => ("payload" in b ? b.payload : undefined));
    expect(payloads).toEqual(["event_near", "event_moscow", "tab_calendar", "menu"]);
  });

  it("/progress shows the summary", async () => {
    const { router, api } = setup();
    await router.handle(message("/progress"));
    expect(api.sent[0].body.text).toContain("Решено задач: 1");
    expect(api.sent[0].body.text).toContain("Ближняя");
  });

  it("/progress invites to the app when there is no data", async () => {
    const { router, api } = setup();
    await router.handle({
      ...message("/progress"),
      message: { ...message("/progress").message, sender: { user_id: 77, first_name: "Новичок" } },
    });
    expect(api.sent[0].body.text).toContain("Пока здесь пусто");
  });

  it("/reminders explains that reminders are not enabled when BOT_REMINDERS=off", async () => {
    const { router, api } = setup({ reminders: false });
    await router.handle(message("/reminders"));
    expect(api.sent[0].body.text).toContain("пока не включены");
    expect(
      buttonsOf(api.sent[0].body).some(
        (b) => b.type === "callback" && b.payload.startsWith("reminders:"),
      ),
    ).toBe(false);
  });

  it("/reminders offers the opt-in when BOT_REMINDERS=on", async () => {
    const { router, api } = setup({ reminders: true });
    await router.handle(message("/reminders"));
    expect(buttonsOf(api.sent[0].body)).toContainEqual({
      type: "callback",
      text: "Включить напоминания",
      payload: "reminders:on",
    });
  });

  it("unknown text gets a short help with buttons", async () => {
    const { router, api } = setup();
    await router.handle(message("что ты умеешь?"));
    expect(api.sent[0].body.text).toContain("понимаю только команды");
    expect(buttonsOf(api.sent[0].body).length).toBeGreaterThan(0);
  });

  it("answers a data error with a friendly message", async () => {
    const { router, api, store } = setup();
    store.loadOlympiads = async () => {
      throw new Error("db down");
    };
    await router.handle(message("/calendar"));
    expect(api.sent[0].body.text).toContain("Не получилось загрузить данные");
  });

  it("ignores group chats and bots", async () => {
    const { router, api } = setup();
    await router.handle(message("/start", { recipient: { chat_type: "chat", chat_id: 1 } }));
    await router.handle(message("/start", { sender: { user_id: 1, is_bot: true } }));
    expect(api.sent).toHaveLength(0);
  });

  it("a 403 while replying marks the user stopped", async () => {
    const { router, api, store } = setup();
    api.fail(
      "sendMessage",
      new MaxApiError({
        status: 403,
        code: "chat.denied",
        message: "x",
        method: "POST",
        path: "/messages",
      }),
    );
    await router.handle(message("/help"));
    expect(store.users.get("42")?.stoppedAt).toBe(NOW);
  });
});

describe("callback buttons", () => {
  it("navigation replaces the pressed message via POST /answers", async () => {
    const { router, api } = setup();
    await router.handle(callback("calendar"));
    expect(api.sent).toHaveLength(0);
    expect(api.answers).toHaveLength(1);
    expect(api.answers[0].callbackId).toBe("cb-calendar");
    expect(api.answers[0].answer.message?.text).toContain("Ближайшие олимпиады");
  });

  it("menu shows the main buttons again", async () => {
    const { router, api } = setup();
    await router.handle(callback("menu"));
    const menu = api.answers[0].answer.message!;
    expect(menu.text).toContain("Меню «Олимпуса»");
    expect(buttonsOf(menu).map((b) => b.text)).toEqual([
      "Открыть Олимпус",
      "Ближайшие олимпиады",
      "Мой прогресс",
      "Как это работает",
    ]);
  });

  it("opt-in and opt-out store the choice and notify", async () => {
    const { router, api, store } = setup({ reminders: true });
    await router.handle(callback("reminders:on"));
    expect(store.users.get("42")?.remindersEnabled).toBe(true);
    expect(api.answers[0].answer.notification).toBe("Напоминания включены");
    expect(api.answers[0].answer.message?.text).toContain("Напоминания включены");
    expect(buttonsOf(api.answers[0].answer.message!)[0]).toMatchObject({
      payload: "reminders:off",
    });

    await router.handle({
      ...callback("reminders:off"),
      callback: { ...callback("reminders:off").callback, callback_id: "cb-2" },
    });
    expect(store.users.get("42")?.remindersEnabled).toBe(false);
    expect(api.answers[1].answer.notification).toBe("Напоминания выключены");
  });

  it("does not enable reminders when BOT_REMINDERS=off", async () => {
    const { router, api, store } = setup({ reminders: false });
    await router.handle(callback("reminders:on"));
    expect(store.users.get("42")?.remindersEnabled).toBe(false);
    expect(api.answers[0].answer.message?.text).toContain("пока не включены");
  });

  it("«Не напоминать» under a reminder only shows a notification", async () => {
    const { router, api, store } = setup({ reminders: true });
    await store.setReminders("42", true);
    await router.handle(callback("reminders:off:quiet"));
    expect(store.users.get("42")?.remindersEnabled).toBe(false);
    expect(api.answers[0].answer).toEqual({ notification: "Напоминания выключены" });
  });

  it("sends a new message when the original one is gone", async () => {
    const { router, api } = setup();
    await router.handle(callback("progress", false));
    expect(api.sent).toHaveLength(1);
    expect(api.answers[0].answer).toEqual({ notification: "Готово" });
  });

  it("falls back to a new message when editing is rejected", async () => {
    const { router, api } = setup();
    api.fail(
      "answerCallback",
      new MaxApiError({ status: 400, message: "cannot edit", method: "POST", path: "/answers" }),
    );
    await router.handle(callback("how"));
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0].body.text).toContain("Как это работает");
  });

  it("unknown payloads (older buttons) show the menu", async () => {
    const { router, api } = setup();
    await router.handle(callback("v0:something"));
    expect(api.answers[0].answer.message?.text).toContain("Меню «Олимпуса»");
  });

  it("always answers the callback, even when the database fails", async () => {
    const { router, api, store } = setup({ reminders: true });
    store.setReminders = async () => {
      throw new Error("db down");
    };
    await router.handle(callback("reminders:off:quiet"));
    await router.handle({
      ...callback("reminders:on"),
      callback: { ...callback("reminders:on").callback, callback_id: "cb-x" },
    });
    expect(
      api.answers.map((a) => a.answer.notification ?? a.answer.message?.text?.slice(0, 20)),
    ).toEqual(["Не получилось. Попробуй ещё раз чуть позже", "Не получилось загруз"]);
  });
});

describe("robustness", () => {
  it("never throws on malformed updates", async () => {
    const { router, api, lines } = setup();
    await router.handle({ update_type: "message_created" });
    await router.handle({ update_type: "message_callback", callback: {} });
    await router.handle({ update_type: "bot_started" });
    await router.handle({ update_type: "chat_title_changed" });
    expect(api.sent).toHaveLength(0);
    expect(lines.some((l) => l.msg === "update_ignored")).toBe(true);
  });

  it("logs only known command names", async () => {
    const { router, lines } = setup();
    await router.handle(message("/calendar"));
    await router.handle(message("/moyparol123"));
    await router.handle(message("просто текст"));
    expect(lines.filter((l) => l.msg === "message").map((l) => l.command)).toEqual([
      "calendar",
      "unknown",
      "text",
    ]);
    expect(JSON.stringify(lines)).not.toContain("moyparol123");
  });

  it("logs failures without message texts", async () => {
    const { router, api, lines } = setup();
    api.fail(
      "sendMessage",
      new MaxApiError({ status: 500, message: "boom", method: "POST", path: "/messages" }),
    );
    await router.handle(message("секретный текст ребёнка"));
    const failure = lines.find((l) => l.msg === "update_failed");
    expect(failure).toMatchObject({ updateType: "message_created", userId: 42, status: 500 });
    expect(JSON.stringify(lines)).not.toContain("секретный");
  });
});
