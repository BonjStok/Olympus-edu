import { describe, expect, it } from "vitest";
import {
  createScheduler,
  dueReminderKind,
  inReminderWindow,
  planReminders,
  runReminderTick,
} from "@/bot/reminders.mjs";
import { reminderScreen } from "@/bot/screens.mjs";
import { MaxApiError } from "@/bot/api.mjs";
import { buttonsOf, fakeApi, memoryLogger, memoryStore, mock, olympiad } from "./helpers";

const WINDOW = { startHour: 10, endHour: 20 };
/** Moscow wall-clock time → epoch ms (Moscow is UTC+3 all year). */
const msk = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);

describe("reminder window (Europe/Moscow)", () => {
  it.each([
    ["09:59", false],
    ["10:00", true],
    ["14:30", true],
    ["19:59", true],
    ["20:00", false],
    ["23:30", false],
  ])("%s → %s", (time, inside) => {
    expect(inReminderWindow(msk("2026-10-01", time), WINDOW)).toBe(inside);
  });

  it("uses Moscow time, not UTC (07:30 UTC = 10:30 MSK)", () => {
    expect(inReminderWindow(Date.UTC(2026, 9, 1, 7, 30), WINDOW)).toBe(true);
    expect(inReminderWindow(Date.UTC(2026, 9, 1, 17, 30), WINDOW)).toBe(false); // 20:30 MSK
  });
});

describe("due reminder kind", () => {
  const noon = msk("2026-10-01", "12:00");
  it.each([
    ["2026-10-04", "d3"],
    ["2026-10-02", "d1"],
    ["2026-10-03", null],
    ["2026-10-05", null],
    ["2026-10-01", null],
    ["2026-09-30", null],
    ["expected", null],
  ])("olympiad on %s → %s", (date, kind) => {
    expect(dueReminderKind(date, noon, WINDOW)).toBe(kind);
  });

  it("counts days by the Moscow calendar around midnight UTC", () => {
    // 2026-10-01 at 23:30 UTC is already 2026-10-02 02:30 in Moscow – outside the window,
    // and at 10:00 MSK on 2026-10-02 the olympiad on 2026-10-05 is D-3.
    expect(dueReminderKind("2026-10-05", Date.UTC(2026, 9, 1, 23, 30), WINDOW)).toBeNull();
    expect(dueReminderKind("2026-10-05", msk("2026-10-02", "10:00"), WINDOW)).toBe("d3");
  });

  it("sends nothing outside the window even on the right day", () => {
    expect(dueReminderKind("2026-10-04", msk("2026-10-01", "08:00"), WINDOW)).toBeNull();
  });
});

describe("planning", () => {
  const now = msk("2026-10-01", "11:00");
  const d3 = olympiad({ id: "d3", date: "2026-10-04" });
  const d1 = olympiad({ id: "d1", date: "2026-10-02" });
  const far = olympiad({ id: "far", date: "2026-10-20" });

  it("plans D-3 and D-1 for registered olympiads only", () => {
    const plan = planReminders(
      [
        { userId: "1", registration: { registered: true }, olympiad: d3, settings: { grade: 5 } },
        { userId: "1", registration: { registered: true }, olympiad: d1, settings: null },
        { userId: "1", registration: { registered: true }, olympiad: far, settings: null },
        { userId: "2", registration: { registered: false }, olympiad: d3, settings: null },
        { userId: "3", registration: null, olympiad: d3, settings: null },
        {
          userId: "4",
          registration: { registered: true },
          olympiad: { ...d3, unpublished: true },
          settings: null,
        },
      ],
      now,
      WINDOW,
    );
    expect(plan.map((p) => `${p.userId}:${p.olympiad.id}:${p.kind}:${p.grade ?? "-"}`)).toEqual([
      "1:d3:d3:5",
      "1:d1:d1:-",
    ]);
  });

  it("de-duplicates repeated rows and skips already-sent reminders", () => {
    const candidate = {
      userId: "1",
      registration: { registered: true },
      olympiad: d3,
      settings: null,
    };
    expect(planReminders([candidate, candidate], now, WINDOW)).toHaveLength(1);
    expect(planReminders([candidate], now, WINDOW, new Set(["1:d3:d3"]))).toHaveLength(0);
  });

  it("plans nothing outside the window", () => {
    const candidate = {
      userId: "1",
      registration: { registered: true },
      olympiad: d3,
      settings: null,
    };
    expect(planReminders([candidate], msk("2026-10-01", "21:00"), WINDOW)).toEqual([]);
  });
});

describe("scheduler tick", () => {
  const olympiads = [
    olympiad({ id: "soon", date: "2026-10-04", title: "Олимпиада MAX" }),
    olympiad({ id: "tomorrow", date: "2026-10-02", title: "Турнир" }),
  ];
  const mocks = [mock({ id: "max-5", grade: 5, olympiad: "Олимпиада MAX" })];

  function setup(now: number) {
    const store = memoryStore({
      olympiads,
      mocks,
      progress: {
        "max:100": {
          "registration:soon": { registered: true },
          "registration:tomorrow": { registered: true },
          settings: { grade: 5 },
        },
        "max:200": { "registration:soon": { registered: true } },
      },
    });
    const api = fakeApi();
    const { logger, lines } = memoryLogger();
    const ctx = {
      app: { webApp: "olympus_bot", contactId: 7 },
      remindersAvailable: true,
      today: "2026-10-01",
    };
    const tick = () =>
      runReminderTick({
        store,
        logger,
        now: () => now,
        window: WINDOW,
        send: (userId, body) => api.sendMessage({ userId }, body),
        render: (p) => reminderScreen(ctx, p),
      });
    return { store, api, tick, lines };
  }

  it("sends each due reminder once to opted-in users only", async () => {
    const { store, api, tick } = setup(msk("2026-10-01", "10:05"));
    await store.setReminders("100", true);
    await store.startUser("200", "Не подписан"); // never opted in

    const first = await tick();
    expect(first).toMatchObject({ planned: 2, sent: 2, failed: 0 });
    expect(api.sent.map((m) => String(m.to.userId))).toEqual(["100", "100"]);
    const [d3, d1] = api.sent.map((m) => m.body);
    expect(d3.text).toContain("Через 3 дня");
    expect(d1.text).toContain("Завтра");
    // D-3 of «Олимпиада MAX» suggests the matching mock test for grade 5.
    expect(buttonsOf(d3).map((b) => ("payload" in b ? b.payload : null))).toEqual([
      "mock_max-5",
      "event_soon",
      "reminders:off:quiet",
    ]);

    const second = await tick();
    expect(second).toMatchObject({ planned: 2, sent: 0, skipped: 2 });
    expect(api.sent).toHaveLength(2);
  });

  it("does nothing outside 10:00–20:00 Moscow time", async () => {
    const { store, api, tick } = setup(msk("2026-10-01", "20:00"));
    await store.setReminders("100", true);
    expect(await tick()).toMatchObject({ outsideWindow: true, sent: 0 });
    expect(api.sent).toHaveLength(0);
  });

  it("skips stopped users", async () => {
    const { store, api, tick } = setup(msk("2026-10-01", "12:00"));
    await store.setReminders("100", true);
    await store.markStopped("100");
    await tick();
    expect(api.sent).toHaveLength(0);
  });

  it("marks the user stopped on 403 and keeps the claim", async () => {
    const { store, api, tick, lines } = setup(msk("2026-10-01", "12:00"));
    await store.setReminders("100", true);
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
    const stats = await tick();
    expect(stats).toMatchObject({ sent: 0, stopped: 1, skipped: 1 });
    expect(store.users.get("100")).toMatchObject({ remindersEnabled: false });
    expect(store.users.get("100")?.stoppedAt).not.toBeNull();
    expect(store.reminders.size).toBe(1);
    expect(lines.some((l) => l.msg === "reminder_forbidden")).toBe(true);
  });

  it("releases the claim after a transient failure so the next run retries", async () => {
    const { store, api, tick } = setup(msk("2026-10-01", "12:00"));
    await store.setReminders("100", true);
    api.fail(
      "sendMessage",
      new MaxApiError({ status: 503, message: "x", method: "POST", path: "/messages" }),
    );
    expect(await tick()).toMatchObject({ sent: 1, failed: 1 });
    expect(await tick()).toMatchObject({ sent: 1, skipped: 1 });
    expect(api.sent).toHaveLength(2);
  });
});

describe("scheduler loop", () => {
  it("never runs two ticks at once", async () => {
    let running = 0;
    let maxRunning = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { logger } = memoryLogger();
    const scheduler = createScheduler({
      intervalMs: 60_000,
      logger,
      tick: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate;
        running -= 1;
        return {};
      },
    });
    const a = scheduler.run();
    const b = scheduler.run();
    release();
    await Promise.all([a, b]);
    expect(maxRunning).toBe(1);
    await scheduler.stop();
  });
});
