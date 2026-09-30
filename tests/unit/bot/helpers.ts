import type { MaxApi, NewMessageBody } from "@/bot/api.mjs";
import type { Olympiad, MockTest } from "@/bot/olympiads.mjs";
import type { BotUser, ReminderCandidate, Store } from "@/bot/store.mjs";
import { createLogger } from "@/bot/log.mjs";

/** 2026-10-01 12:00 Moscow (09:00 UTC). */
export const NOW = Date.UTC(2026, 9, 1, 9, 0, 0);

export function olympiad(overrides: Partial<Olympiad> & { id: string }): Olympiad {
  return {
    title: `Олимпиада ${overrides.id}`,
    subject: "math",
    grades: [4, 5, 6],
    format: "online",
    region: "",
    date: "2026-10-20",
    deadline: "2026-10-15",
    url: "https://example.org",
    ...overrides,
  };
}

export function mock(overrides: Partial<MockTest> & { id: string }): MockTest {
  return {
    title: `Пробный тур ${overrides.id}`,
    grade: 5,
    subject: "math",
    olympiad: "Учебный тур Олимпуса",
    minutes: 45,
    ...overrides,
  };
}

/** Collects log lines for assertions. */
export function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => lines.push(JSON.parse(line)),
  });
  return { logger, lines };
}

export interface SentMessage {
  to: { userId?: string | number; chatId?: string | number };
  body: NewMessageBody;
}
export interface Answer {
  callbackId: string;
  answer: { message?: NewMessageBody; notification?: string };
}

/** Records API calls; `fail` lets a test make a method throw. */
export function fakeApi() {
  const sent: SentMessage[] = [];
  const answers: Answer[] = [];
  const failures: { method: "sendMessage" | "answerCallback"; error: unknown }[] = [];
  const api = {
    sent,
    answers,
    fail(method: "sendMessage" | "answerCallback", error: unknown) {
      failures.push({ method, error });
    },
    async sendMessage(to: SentMessage["to"], body: NewMessageBody) {
      const i = failures.findIndex((f) => f.method === "sendMessage");
      if (i >= 0) throw failures.splice(i, 1)[0].error;
      sent.push({ to, body });
      return { message: { body: { mid: `mid.${sent.length}` } } };
    },
    async answerCallback(callbackId: string, answer: Answer["answer"]) {
      const i = failures.findIndex((f) => f.method === "answerCallback");
      if (i >= 0) throw failures.splice(i, 1)[0].error;
      answers.push({ callbackId, answer });
      return { success: true };
    },
  };
  return api as typeof api & MaxApi;
}

/** In-memory Store with the same semantics as the PostgreSQL one. */
export function memoryStore(
  init: {
    olympiads?: Olympiad[];
    mocks?: MockTest[];
    progress?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const users = new Map<string, BotUser>();
  const reminders = new Set<string>();
  const progress = init.progress ?? {};
  const olympiads = init.olympiads ?? [];
  const mocks = init.mocks ?? [];
  const store = {
    users,
    reminders,
    async checkSchema() {
      return true;
    },
    async startUser(userId: string, firstName: string | null) {
      const user: BotUser = {
        userId,
        firstName: firstName ?? users.get(userId)?.firstName ?? null,
        startedAt: NOW,
        stoppedAt: null,
        remindersEnabled: users.get(userId)?.remindersEnabled ?? false,
      };
      users.set(userId, user);
      return user;
    },
    async touchUser(userId: string, firstName: string | null) {
      const prev = users.get(userId);
      const user: BotUser = {
        userId,
        firstName: firstName ?? prev?.firstName ?? null,
        startedAt: prev?.startedAt ?? null,
        stoppedAt: null,
        remindersEnabled: prev?.remindersEnabled ?? false,
      };
      users.set(userId, user);
      return user;
    },
    async markStopped(userId: string) {
      const prev = users.get(userId);
      users.set(userId, {
        userId,
        firstName: prev?.firstName ?? null,
        startedAt: prev?.startedAt ?? null,
        stoppedAt: NOW,
        remindersEnabled: false,
      });
    },
    async setReminders(userId: string, enabled: boolean) {
      const prev = await store.touchUser(userId, null);
      const user = { ...prev, remindersEnabled: enabled };
      users.set(userId, user);
      return user;
    },
    async getUser(userId: string) {
      return users.get(userId) ?? null;
    },
    async loadProgress(userId: string) {
      return Object.entries(progress[`max:${userId}`] ?? {}).map(([key, data]) => ({ key, data }));
    },
    async loadOlympiads() {
      return olympiads;
    },
    async loadMockTests() {
      return mocks;
    },
    async reminderCandidates(): Promise<ReminderCandidate[]> {
      const out: ReminderCandidate[] = [];
      for (const user of users.values()) {
        if (!user.remindersEnabled || user.stoppedAt) continue;
        const rows = progress[`max:${user.userId}`] ?? {};
        for (const [key, registration] of Object.entries(rows)) {
          if (!key.startsWith("registration:")) continue;
          const o = olympiads.find((x) => x.id === key.slice("registration:".length));
          if (o)
            out.push({ userId: user.userId, registration, olympiad: o, settings: rows.settings });
        }
      }
      return out;
    },
    async claimReminder(userId: string, olympiadId: string, kind: string) {
      const key = `${userId}:${olympiadId}:${kind}`;
      if (reminders.has(key)) return false;
      reminders.add(key);
      return true;
    },
    async releaseReminder(userId: string, olympiadId: string, kind: string) {
      reminders.delete(`${userId}:${olympiadId}:${kind}`);
    },
  };
  return store as typeof store & Store;
}

/** Joins all visible text of a message and its buttons for assertions. */
export function buttonsOf(body: NewMessageBody) {
  return (body.attachments ?? []).flatMap((a) => a.payload.buttons.flat());
}
