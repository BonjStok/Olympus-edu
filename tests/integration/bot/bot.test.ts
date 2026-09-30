/**
 * End-to-end flows of the chat-bot against PostgreSQL (TEST_DATABASE_URL) and a fake
 * MAX Bot API. The bot runs in-process exactly as bot/server.mjs starts it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startBot, type BotService } from "@/bot/app.mjs";
import { createLogger } from "@/bot/log.mjs";
import { FAKE_BOT, startFakeMaxApi, type FakeMaxApi } from "./fake-max-api";
import { insertProgress, insertRecords, migrate, query, reset } from "./db";

const SECRET = "it_webhook-secret-42";
/** Moscow wall-clock time → epoch ms. */
const msk = (date: string, time = "11:00") => Date.parse(`${date}T${time}:00+03:00`);

const KID = 700001; // has used the mini-app: settings, progress, registrations
const NEWBIE = 700002; // never opened the mini-app

const olympiads = [
  {
    id: "max-olymp",
    kind: "olympiads",
    title: "Олимпиада MAX по математике",
    subject: "math",
    grades: [5, 6],
    format: "online",
    region: "",
    deadline: "2026-10-03",
    date: "2026-10-04",
    url: "https://example.org/max",
  },
  {
    id: "tomorrow-cup",
    kind: "olympiads",
    title: "Турнир «Завтра»",
    subject: "info",
    grades: [5],
    format: "online",
    region: "",
    deadline: "2026-09-30",
    date: "2026-10-02",
    url: "https://example.org/t",
  },
  {
    id: "moscow-city",
    kind: "olympiads",
    title: "Московская олимпиада",
    subject: "math",
    grades: [5],
    format: "offline",
    region: "Москва",
    registrationType: "school",
    date: "2026-10-09",
    url: "https://example.org/m",
  },
  {
    id: "vsosh-moscow",
    kind: "olympiads",
    title: "ВсОШ – математика – школьный этап",
    subject: "math",
    grades: [4, 5, 6],
    format: "online",
    region: "Москва",
    series: "vsosh-school-2026-math",
    deadline: "2026-10-10",
    date: "2026-10-12",
    url: "https://example.org/v",
  },
  {
    id: "vsosh-spb",
    kind: "olympiads",
    title: "ВсОШ – математика – школьный этап",
    subject: "math",
    grades: [4, 5, 6],
    format: "online",
    region: "Санкт-Петербург",
    series: "vsosh-school-2026-math",
    deadline: "2026-10-06",
    date: "2026-10-08",
    url: "https://example.org/v",
  },
  {
    id: "spb-only",
    kind: "olympiads",
    title: "Петербургская олимпиада",
    subject: "math",
    grades: [5],
    format: "offline",
    region: "Санкт-Петербург",
    date: "2026-10-07",
    url: "https://example.org/s",
  },
  {
    id: "grade4-only",
    kind: "olympiads",
    title: "Для 4 класса",
    subject: "math",
    grades: [4],
    format: "online",
    region: "",
    date: "2026-10-05",
    url: "https://example.org/g",
  },
  {
    id: "past",
    kind: "olympiads",
    title: "Прошедшая",
    subject: "math",
    grades: [5],
    format: "online",
    region: "",
    date: "2026-09-20",
    url: "https://example.org/p",
  },
  {
    id: "hidden",
    kind: "olympiads",
    title: "Черновик",
    subject: "math",
    grades: [5],
    format: "online",
    region: "",
    date: "2026-10-03",
    url: "https://example.org/h",
    unpublished: true,
  },
];

const mocks = [
  {
    id: "max-2026-math-5",
    kind: "mock-tests",
    title: "Олимпиада MAX · 5 класс",
    grade: 5,
    subject: "math",
    olympiad: "Олимпиада MAX",
    minutes: 45,
    taskIds: ["t1"],
  },
];

const kidProgress = {
  settings: { region: "Москва", grade: 5 },
  "registration:max-olymp": { registered: true },
  "registration:tomorrow-cup": { registered: true },
  "registration:past": { registered: true },
  "theory-star:topic-1": { title: "Чётность", subject: "math", type: "theory", date: 1 },
  "practice-star:topic-1": { title: "Чётность", subject: "math", type: "practice", date: 2 },
  "task:1": {
    title: "1",
    topicId: "topic-1",
    subject: "math",
    correct: true,
    lastCorrect: true,
    attempts: 1,
    selfChecked: false,
  },
  "task:2": {
    title: "2",
    topicId: "topic-1",
    subject: "math",
    correct: true,
    lastCorrect: true,
    attempts: 2,
    selfChecked: false,
  },
  "task:3": {
    title: "3",
    topicId: "topic-2",
    subject: "info",
    correct: true,
    lastCorrect: true,
    attempts: 1,
    selfChecked: false,
  },
  "attempt:a1": {
    id: "a1",
    testId: "max-2026-math-5",
    title: "Олимпиада MAX · 5 класс",
    subject: "math",
    started: 1,
    ends: 2,
    tasks: [],
    answers: {},
    finished: true,
    finishedAt: Date.parse("2026-09-20T12:00:00+03:00"),
    score: 7,
    max: 10,
  },
};

async function waitFor<T>(
  fn: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const logs: Record<string, unknown>[] = [];
const testLogger = createLogger({ level: "debug", write: (line) => logs.push(JSON.parse(line)) });

let fake: FakeMaxApi;
let bot: BotService | null = null;
let clock = msk("2026-10-01");

async function start(env: Record<string, string> = {}) {
  bot = await startBot({
    env: {
      BOT_TOKEN: fake.token,
      MAX_API_URL: fake.url,
      DATABASE_URL: String(process.env.TEST_DATABASE_URL),
      DB_SSL: "false",
      BOT_MODE: "webhook",
      BOT_WEBHOOK_URL: "https://olympus.test/max/webhook",
      BOT_WEBHOOK_SECRET: SECRET,
      BOT_REMINDERS: "on",
      ...env,
    },
    port: 0,
    host: "127.0.0.1",
    now: () => clock,
    chatIntervalMs: 0,
    retryDelayMs: 50,
    logger: testLogger,
  });
  await bot.initialized;
  return bot;
}

function deliver(update: unknown, secret = SECRET) {
  return fetch(`${bot!.url}/max/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Max-Bot-Api-Secret": secret },
    body: JSON.stringify(update),
  });
}

const kid = { user_id: KID, first_name: "Маша", is_bot: false };
const newbie = { user_id: NEWBIE, first_name: "Петя", is_bot: false };
let seq = 0;
const text = (user: typeof kid, body: string) => ({
  update_type: "message_created",
  timestamp: clock + ++seq,
  message: {
    sender: user,
    recipient: { chat_type: "dialog", chat_id: 90000 + Number(user.user_id) },
    timestamp: clock,
    body: { mid: `mid.${++seq}`, seq, text: body },
  },
});
const press = (user: typeof kid, payload: string) => ({
  update_type: "message_callback",
  timestamp: clock + ++seq,
  callback: { callback_id: `cb.${++seq}`, payload, user, timestamp: clock },
  message: { recipient: { chat_type: "dialog" }, body: { mid: "mid.menu", seq: 1, text: "…" } },
});
const lifecycle = (type: string, user: typeof kid, extra: Record<string, unknown> = {}) => ({
  update_type: type,
  timestamp: clock + ++seq,
  chat_id: 90000 + Number(user.user_id),
  user,
  user_locale: "ru",
  ...extra,
});

async function messagesTo(userId: number, count: number) {
  return waitFor(() => {
    const list = fake.calls("POST", "/messages").filter((r) => r.query.user_id === String(userId));
    return list.length >= count ? list : null;
  });
}

beforeAll(() => {
  migrate();
});

beforeEach(async () => {
  clock = msk("2026-10-01");
  logs.length = 0;
  await reset();
  await insertRecords([...olympiads, ...mocks]);
  await insertProgress(KID, kidProgress);
  fake = await startFakeMaxApi();
});

afterEach(async () => {
  await bot?.stop();
  bot = null;
  await fake.close();
});

describe("start-up in webhook mode", () => {
  it("identifies the bot, registers commands and subscribes the webhook", async () => {
    await start();
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /me",
      "PATCH /me/commands",
      "GET /subscriptions",
      "POST /subscriptions",
    ]);
    for (const r of fake.requests) expect(r.headers.authorization).toBe(fake.token);
    expect(
      fake.calls("PATCH", "/me/commands")[0].body.commands.map((c: { name: string }) => c.name),
    ).toEqual(["start", "calendar", "progress", "reminders", "help"]);
    expect(fake.calls("POST", "/subscriptions")[0].body).toEqual({
      url: "https://olympus.test/max/webhook",
      secret: SECRET,
      update_types: [
        "bot_started",
        "bot_stopped",
        "bot_removed",
        "dialog_removed",
        "message_created",
        "message_callback",
      ],
    });

    const health = await (await fetch(`${bot!.url}/health`)).json();
    expect(health).toMatchObject({
      status: "ok",
      mode: "webhook",
      token: "ok",
      db: "ok",
      bot: { name: FAKE_BOT.username, id: FAKE_BOT.user_id },
      delivery: { type: "webhook", path: "/max/webhook", subscribed: true },
      reminders: "on",
    });
  });

  it("does not re-subscribe when the subscription already exists", async () => {
    await start();
    await bot!.stop();
    fake.requests.length = 0;
    await start();
    expect(fake.calls("POST", "/subscriptions")).toHaveLength(0);
  });

  it("uses MAX_BOT_NAME for open_app when it is set", async () => {
    await start({ MAX_BOT_NAME: "id7700000000_bot" });
    await deliver(lifecycle("bot_started", newbie));
    const [greeting] = await messagesTo(NEWBIE, 1);
    const buttons = greeting.body.attachments[0].payload.buttons.flat();
    expect(buttons[0]).toMatchObject({ type: "open_app", web_app: "id7700000000_bot" });
  });
});

describe("webhook security", () => {
  it("rejects a wrong secret with 401 and processes nothing", async () => {
    await start();
    const res = await deliver(lifecycle("bot_started", newbie), "wrong-secret");
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls("POST", "/messages")).toHaveLength(0);
    expect(await query("SELECT * FROM bot_users")).toHaveLength(0);
  });

  it("processes a redelivered update only once", async () => {
    await start();
    const update = lifecycle("bot_started", newbie);
    expect((await deliver(update)).status).toBe(200);
    expect((await deliver(update)).status).toBe(200);
    await messagesTo(NEWBIE, 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls("POST", "/messages")).toHaveLength(1);
  });
});

describe("bot_started", () => {
  it("sends the greeting with the mini-app button and stores the user", async () => {
    await start();
    const res = await deliver(lifecycle("bot_started", newbie, { payload: "event_max-olymp" }));
    expect(res.status).toBe(200);
    const [greeting] = await messagesTo(NEWBIE, 1);

    expect(greeting.query).toEqual({ user_id: String(NEWBIE) });
    expect(greeting.headers["content-type"]).toBe("application/json");
    expect(greeting.body.format).toBe("markdown");
    expect(greeting.body.text).toContain("Привет, Петя! 👋");
    expect(greeting.body.text).toContain("4–6 классов");
    expect(greeting.body.attachments).toEqual([
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [
              {
                type: "open_app",
                text: "Открыть Олимпус",
                web_app: FAKE_BOT.username,
                contact_id: FAKE_BOT.user_id,
                payload: "event_max-olymp",
              },
            ],
            [
              { type: "callback", text: "Ближайшие олимпиады", payload: "calendar" },
              { type: "callback", text: "Мой прогресс", payload: "progress" },
            ],
            [{ type: "callback", text: "Как это работает", payload: "how" }],
          ],
        },
      },
    ]);

    const [row] = await query("SELECT * FROM bot_users WHERE user_id = $1", [String(NEWBIE)]);
    expect(row).toMatchObject({ first_name: "Петя", stopped_at: null, reminders_enabled: false });
    expect(Number(row.started_at)).toBe(clock);
  });
});

describe("commands with data from the app", () => {
  it("/calendar uses the child's region and grade from the mini-app settings", async () => {
    await start();
    await deliver(text(kid, "/calendar"));
    const [reply] = await messagesTo(KID, 1);
    const body = reply.body.text as string;
    expect(body).toContain("5 класс · Москва и вся Россия");
    const titles = [...body.matchAll(/^\d\. \*\*(.+?)\*\*/gm)].map((m) => m[1]);
    expect(titles).toEqual([
      "Турнир «Завтра»",
      "Олимпиада MAX по математике",
      "Московская олимпиада",
      "ВсОШ – математика – школьный этап",
    ]);
    expect(body).not.toContain("Петербургская");
    expect(body).not.toContain("Для 4 класса");
    expect(body).not.toContain("Прошедшая");
    expect(body).not.toContain("Черновик");
    expect(body).toContain("Участников регистрирует школа");
    const payloads = reply.body.attachments[0].payload.buttons
      .flat()
      .map((b: { payload?: string }) => b.payload);
    expect(payloads).toEqual([
      "event_tomorrow-cup",
      "event_max-olymp",
      "event_moscow-city",
      "event_vsosh-moscow",
      "tab_calendar",
      "menu",
    ]);
    for (const row of reply.body.attachments[0].payload.buttons)
      expect(row.filter((b: { type: string }) => b.type === "open_app").length).toBeLessThanOrEqual(
        3,
      );
  });

  it("/calendar without settings shows all-Russia events and collapses regional series", async () => {
    await start();
    await deliver(text(newbie, "Календарь"));
    const [reply] = await messagesTo(NEWBIE, 1);
    const body = reply.body.text as string;
    expect(body).toContain("**Ближайшие олимпиады**\nвся Россия");
    expect(body).toContain("Для 4 класса"); // no grade filter without settings
    expect(body).toContain("от 8 октября · математика · в 2 регионах, даты зависят от региона");
    expect(body).not.toContain("Московская олимпиада");
    expect(body).toContain("Укажи класс и регион");
    const buttons = reply.body.attachments[0].payload.buttons.flat();
    expect(buttons.find((b: { text: string }) => b.text.includes("ВсОШ")).payload).toBe(
      "tab_calendar",
    );
  });

  it("/progress summarises the child's progress and «Мои олимпиады»", async () => {
    await start();
    await deliver(text(kid, "/progress"));
    const [reply] = await messagesTo(KID, 1);
    const body = reply.body.text as string;
    expect(body).toContain("Звёзды за пройденные блоки: 2");
    expect(body).toContain("Решено задач: 3 (математика – 2, информатика – 1)");
    expect(body).toContain("Медали: 2 из 10");
    expect(body).toContain("До медали «Исследователь» (математика) – ещё 3 задачи.");
    expect(body).toContain("«Олимпиада MAX · 5 класс» – 7 из 10 баллов, 20 сентября");
    expect(body).toContain(
      "• 2 октября – Турнир «Завтра»\n• 4 октября – Олимпиада MAX по математике",
    );
    expect(body).not.toContain("Прошедшая");
  });

  it("/progress invites a new user to open the app", async () => {
    await start();
    await deliver(text(newbie, "/progress"));
    const [reply] = await messagesTo(NEWBIE, 1);
    expect(reply.body.text).toContain("Пока здесь пусто");
    expect(reply.body.attachments[0].payload.buttons[0][0]).toMatchObject({
      type: "open_app",
      payload: "tab_training",
    });
  });

  it("callback buttons are acknowledged with POST /answers", async () => {
    await start();
    await deliver(press(kid, "progress"));
    const [answer] = await waitFor(() => {
      const list = fake.calls("POST", "/answers");
      return list.length ? list : null;
    });
    expect(answer.query.callback_id).toMatch(/^cb\./);
    expect(answer.body.message.text).toContain("Твой прогресс");
    expect(fake.calls("POST", "/messages")).toHaveLength(0);
  });
});

describe("reminders", () => {
  async function optIn(user = kid) {
    await deliver(press(user, "reminders:on"));
    await waitFor(() => fake.calls("POST", "/answers").length > 0);
    const [row] = await query("SELECT reminders_enabled FROM bot_users WHERE user_id = $1", [
      String(user.user_id),
    ]);
    expect(row.reminders_enabled).toBe(true);
  }

  it("opt-in → the scheduler sends exactly one reminder per kind", async () => {
    await start();
    await optIn();
    expect(fake.calls("POST", "/answers")[0].body.notification).toBe("Напоминания включены");

    // 2026-10-01 11:00 MSK: «Олимпиада MAX» (4 Oct) is D-3, «Турнир «Завтра»» is D-1.
    await bot!.scheduler!.run();
    const first = fake.calls("POST", "/messages");
    expect(first).toHaveLength(2);
    const d3 = first.find((m) => m.body.text.includes("Через 3 дня"))!;
    const d1 = first.find((m) => m.body.text.includes("Завтра"))!;
    expect(d3.query.user_id).toBe(String(KID));
    expect(d3.body.text).toContain("**4 октября**");
    expect(
      d3.body.attachments[0].payload.buttons.flat().map((b: { payload: string }) => b.payload),
    ).toEqual(["mock_max-2026-math-5", "event_max-olymp", "reminders:off:quiet"]);
    expect(d1.body.text).toContain("Турнир «Завтра»");

    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(2);

    // Two days later «Олимпиада MAX» is tomorrow: its D-1 goes out once.
    clock = msk("2026-10-03", "10:30");
    await bot!.scheduler!.run();
    await bot!.scheduler!.run();
    const all = fake.calls("POST", "/messages");
    expect(all).toHaveLength(3);
    expect(all[2].body.text).toContain("Завтра, **4 октября**");

    const sent = await query(
      "SELECT olympiad_id, kind FROM bot_reminders ORDER BY olympiad_id, kind",
    );
    expect(sent).toEqual([
      { olympiad_id: "max-olymp", kind: "d1" },
      { olympiad_id: "max-olymp", kind: "d3" },
      { olympiad_id: "tomorrow-cup", kind: "d1" },
    ]);
  });

  it("sends nothing outside 10:00–20:00 Moscow time", async () => {
    await start();
    await optIn();
    clock = msk("2026-10-01", "21:15");
    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(0);
  });

  it("never writes to users who did not opt in", async () => {
    await start();
    await deliver(lifecycle("bot_started", kid));
    await messagesTo(KID, 1);
    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(1); // only the greeting
  });

  it("bot_stopped → no messages, reminders switched off until a new opt-in", async () => {
    await start();
    await optIn();
    await deliver(lifecycle("bot_stopped", kid));
    const [row] = await waitFor(async () => {
      const rows = await query("SELECT * FROM bot_users WHERE user_id = $1", [String(KID)]);
      return rows[0]?.stopped_at != null ? rows : null;
    });
    expect(Number(row.stopped_at)).toBe(clock);
    expect(row.reminders_enabled).toBe(false);

    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(0);

    // Starting again greets the user but does not silently re-enable reminders.
    await deliver(lifecycle("bot_started", kid));
    await messagesTo(KID, 1);
    const [again] = await query("SELECT * FROM bot_users WHERE user_id = $1", [String(KID)]);
    expect(again.stopped_at).toBeNull();
    expect(again.reminders_enabled).toBe(false);
    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(1);
  });

  it("a 403 (chat.denied) marks the user stopped and is not retried", async () => {
    await start();
    await optIn();
    fake.forbid(KID);
    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(1);
    const [row] = await query("SELECT * FROM bot_users WHERE user_id = $1", [String(KID)]);
    expect(row.stopped_at).not.toBeNull();
    expect(row.reminders_enabled).toBe(false);
    await bot!.scheduler!.run();
    expect(fake.calls("POST", "/messages")).toHaveLength(1);
  });

  it("/reminders says reminders are not enabled when BOT_REMINDERS=off", async () => {
    await start({ BOT_REMINDERS: "off" });
    expect(bot!.scheduler).toBeNull();
    await deliver(text(kid, "/reminders"));
    const [reply] = await messagesTo(KID, 1);
    expect(reply.body.text).toContain("Напоминания в чате пока не включены");
  });
});

describe("long polling", () => {
  it("passes the marker of the previous batch and handles each update once", async () => {
    const help = text(newbie, "/help");
    fake.queueUpdates({ updates: [lifecycle("bot_started", newbie), help], marker: 41 });
    fake.queueUpdates({ updates: [help], marker: 42 }); // the same message delivered again
    await start({ BOT_MODE: "polling", BOT_WEBHOOK_URL: "", BOT_WEBHOOK_SECRET: "" });

    await messagesTo(NEWBIE, 2);
    const polls = await waitFor(() => {
      const list = fake.calls("GET", "/updates");
      return list.length >= 3 ? list : null;
    });
    expect(polls[0].query.marker).toBeUndefined();
    expect(polls[1].query.marker).toBe("41");
    expect(polls[2].query.marker).toBe("42");
    expect(polls[0].query.types).toBe(
      "bot_started,bot_stopped,bot_removed,dialog_removed,message_created,message_callback",
    );
    expect(Number(polls[0].query.timeout)).toBeGreaterThan(0);
    // A replayed update (same message id) is not answered twice.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls("POST", "/messages")).toHaveLength(2);
    expect(fake.calls("POST", "/subscriptions")).toHaveLength(0);

    const health = await (await fetch(`${bot!.url}/health`)).json();
    expect(health).toMatchObject({
      status: "ok",
      mode: "polling",
      delivery: { type: "polling", running: true },
    });
    // The webhook endpoint is not exposed in polling mode.
    expect((await deliver(lifecycle("bot_started", newbie))).status).toBe(404);
  });
});

describe("degraded start-up", () => {
  it("stays up without BOT_TOKEN in disabled mode and never calls the API", async () => {
    await start({ BOT_TOKEN: "" });
    const res = await fetch(`${bot!.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "disabled",
      mode: "disabled",
      token: "missing",
      db: "ok",
    });
    expect((await deliver(lifecycle("bot_started", newbie))).status).toBe(404);
    expect(fake.requests).toHaveLength(0);
  });

  it("reports an invalid token as an error (503) without crashing", async () => {
    await start({ BOT_TOKEN: "wrong-token-value" });
    const res = await fetch(`${bot!.url}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "error", token: "invalid" });
    expect(logs.some((l) => l.msg === "bot_token_invalid")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("wrong-token-value");
  });
});
