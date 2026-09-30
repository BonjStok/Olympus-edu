/**
 * In-memory stand-in for `/api/olympus` used by UI tests. It follows the server rules
 * closely enough for the screens (answers, stars, registrations, mock attempts).
 */
import type {
  ContentRecord,
  Features,
  Lesson,
  MockAnswer,
  MockAttempt,
  MockResult,
  MockTest,
  Olympiad,
  OlympiadSummary,
  OlympusAction,
  OlympusRpc,
  Profile,
  ProgressMap,
  Task,
  Topic,
} from "@/lib/domain/types";
import { ApiError, type ApiClient, type Bootstrap } from "@/lib/client/api";

/** May return a promise to hold the answer (e.g. to look at a loading state). */
type Handler = (payload: Record<string, unknown>) => unknown;

export interface FakeServerOptions {
  records: ContentRecord[];
  progress?: ProgressMap;
  profile?: Partial<Profile>;
  features?: Partial<Features>;
  /**
   * The old server: no `settings` / `mock-get` / `olympiad` actions, complete olympiads in the
   * bootstrap catalogue.
   */
  legacy?: boolean;
  /** Override or break single actions. */
  handlers?: Partial<Record<OlympusAction | "bootstrap", Handler>>;
  now?: () => number;
}

export interface FakeApi extends ApiClient {
  calls: { action: string; payload: Record<string, unknown> }[];
  progress: ProgressMap;
  failNext(action: OlympusAction | "bootstrap", error: ApiError): void;
}

function publicTask(t: Task) {
  const copy: Partial<Task> = { ...t };
  delete copy.answer;
  delete copy.solution;
  delete copy.hint;
  delete copy.tests;
  return copy;
}

/** The catalogue entry of an olympiad, as the server sends it (see `olympiadSummary`). */
function olympiadSummary(o: Olympiad): OlympiadSummary {
  const copy: Partial<Olympiad> = { ...o };
  delete copy.description;
  delete copy.source;
  delete copy.verifiedAt;
  delete copy.image;
  return copy as OlympiadSummary;
}

export function createFakeApi(options: FakeServerOptions): FakeApi {
  const records = options.records;
  const progress: ProgressMap = { ...(options.progress ?? {}) };
  const now = options.now ?? Date.now;
  const calls: FakeApi["calls"] = [];
  const failures = new Map<string, ApiError>();
  const byId = new Map(records.map((r) => [r.id, r]));
  const record = <T extends ContentRecord>(id: unknown): T => {
    const r = byId.get(String(id));
    if (!r) throw new ApiError(404, "NOT_FOUND", "Не нашли этот материал. Возможно, его убрали");
    return r as T;
  };

  const grade = (a: MockAttempt): MockAttempt => {
    const results: MockResult[] = (a.tasks as Task[]).map((t) => {
      const full = record<Task>(t.id);
      const ans = a.answers[t.id];
      const ok =
        t.type === "number" &&
        typeof ans === "string" &&
        Number(ans.replace(",", ".")) === Number(full.answer);
      const max = full.points ?? 1;
      return {
        id: t.id,
        correct: ok,
        points: ok ? max : 0,
        max,
        note: "",
        status: ok ? "correct" : "wrong",
      };
    });
    return {
      ...a,
      tasks: (a.tasks as Task[]).map((t) => {
        const full = record<Task>(t.id);
        const copy: Partial<Task> = { ...full };
        delete copy.tests;
        return copy as Task;
      }),
      finished: true,
      finishedAt: now(),
      results,
      score: results.reduce((n, r) => n + r.points, 0),
      max: results.reduce((n, r) => n + r.max, 0),
    };
  };

  const handlers: Record<string, Handler> = {
    session: () => ({ ok: true, sessionToken: "test-token" }),
    settings: (p) => {
      if (options.legacy) throw new ApiError(400, "BAD_REQUEST", "Неизвестное действие");
      progress.settings = { ...(progress.settings as object), ...p };
      return { ok: true, settings: progress.settings };
    },
    "view-lesson": (p) => {
      progress[`lesson:${p.id}`] = { read: true };
      return { ok: true };
    },
    star: (p) => {
      const topic = record<Topic>(p.id);
      progress[`theory-star:${p.id}`] = {
        title: topic.title,
        subject: topic.subject,
        type: "theory",
        date: now(),
      };
      return { ok: true };
    },
    olympiad: (p) => {
      if (options.legacy) throw new ApiError(400, "BAD_REQUEST", "Неизвестное действие");
      const r = byId.get(String(p.id));
      if (!r || r.kind !== "olympiads" || r.unpublished)
        throw new ApiError(404, "OLYMPIAD_NOT_FOUND", "Олимпиада не найдена");
      return { olympiad: r };
    },
    register: (p) => {
      record(p.id);
      if (p.yes) progress[`registration:${p.id}`] = { registered: true };
      else delete progress[`registration:${p.id}`];
      return { ok: true, registered: !!p.yes };
    },
    "code-draft": (p) => {
      progress[`code:${p.id}`] = { code: p.code, language: p.language };
      return { ok: true };
    },
    "topic-content": (p) => {
      const lessons = records.filter(
        (r): r is Lesson => r.kind === "lessons" && r.topicId === p.id,
      );
      const tasks = records
        .filter((r): r is Task => r.kind === "tasks" && r.topicId === p.id)
        .map(publicTask);
      return { lessons, tasks };
    },
    check: (p) => {
      const task = record<Task>(p.id);
      let correct = false;
      if (task.type === "number") {
        const raw = String(p.answer ?? "").trim();
        if (!/^[-+]?\d+(?:[.,]\d+)?$/.test(raw))
          throw new ApiError(400, "BAD_REQUEST", "Введите число, например 12 или 0,5");
        correct = Number(raw.replace(",", ".")) === Number(task.answer);
      } else if (task.type === "proof") correct = p.correct === true;
      const key = `task:${task.id}`;
      const old = progress[key] as { correct?: boolean; attempts?: number } | undefined;
      progress[key] = {
        title: task.title,
        topicId: task.topicId,
        subject: task.subject,
        correct: correct || !!old?.correct,
        lastCorrect: correct,
        attempts: (old?.attempts ?? 0) + 1,
        selfChecked: task.type === "proof",
      };
      const solved = Object.entries(progress).filter(
        ([k, v]) =>
          k.startsWith("task:") &&
          (v as { topicId?: string; correct?: boolean }).topicId === task.topicId &&
          (v as { correct?: boolean }).correct,
      ).length;
      let practiceStar = false;
      if (correct && solved >= 3 && !progress[`practice-star:${task.topicId}`]) {
        progress[`practice-star:${task.topicId}`] = {
          title: "Тема",
          subject: task.subject,
          type: "practice",
          date: now(),
        };
        practiceStar = true;
      }
      return { correct, output: "", practiceStar };
    },
    hint: (p) => ({ hint: record<Task>(p.id).hint ?? "Разбей условие на шаги" }),
    reveal: (p) => {
      const t = record<Task>(p.id);
      return { answer: t.answer, solution: t.solution };
    },
    "start-mock": (p) => {
      const test = record<MockTest>(p.id);
      const tasks = test.taskIds.map((id) => publicTask(record<Task>(id))) as Task[];
      const attempt: MockAttempt = {
        id: `attempt-${calls.length}`,
        testId: test.id,
        title: test.title,
        subject: test.subject,
        started: now(),
        ends: now() + test.minutes * 60_000,
        tasks,
        answers: {},
        finished: false,
      };
      progress[`attempt:${attempt.id}`] = attempt;
      return { attempt };
    },
    "mock-get": (p) => {
      if (options.legacy) throw new ApiError(400, "BAD_REQUEST", "Неизвестное действие");
      const a = progress[`attempt:${p.id}`] as MockAttempt | undefined;
      if (!a) throw new ApiError(404, "NOT_FOUND", "Попытка не найдена");
      return { attempt: a };
    },
    "mock-save": (p) => {
      const a = progress[`attempt:${p.id}`] as MockAttempt;
      const answers = p.answers as Record<string, MockAnswer>;
      a.answers = options.legacy ? answers : { ...a.answers, ...answers };
      for (const [k, v] of Object.entries(a.answers)) if (v === "") delete a.answers[k];
      return { ok: true };
    },
    "finish-mock": (p) => {
      const a = progress[`attempt:${p.id}`] as MockAttempt;
      if (p.answers) a.answers = { ...a.answers, ...(p.answers as Record<string, MockAnswer>) };
      const done = grade(a);
      progress[`attempt:${p.id}`] = done;
      return { attempt: done };
    },
  };

  const run = async (action: string, payload: Record<string, unknown>) => {
    calls.push({ action, payload });
    await Promise.resolve();
    const failure = failures.get(action);
    if (failure) {
      failures.delete(action);
      throw failure;
    }
    const custom = options.handlers?.[action as OlympusAction];
    const handler = custom ?? handlers[action];
    if (!handler) throw new ApiError(400, "BAD_REQUEST", "Неизвестное действие");
    return JSON.parse(JSON.stringify(await handler(payload)));
  };

  const api: FakeApi = {
    calls,
    progress,
    failNext(action, error) {
      failures.set(action, error);
    },
    async call<A extends OlympusAction>(action: A, payload: OlympusRpc[A]["req"]) {
      return (await run(action, payload as Record<string, unknown>)) as OlympusRpc[A]["res"];
    },
    async bootstrap(): Promise<Bootstrap> {
      calls.push({ action: "bootstrap", payload: {} });
      await Promise.resolve();
      const failure = failures.get("bootstrap");
      if (failure) {
        failures.delete("bootstrap");
        throw failure;
      }
      return JSON.parse(
        JSON.stringify({
          records: records.map((r) =>
            r.kind === "lessons"
              ? { ...r, blocks: undefined }
              : r.kind === "tasks"
                ? publicTask(r)
                : r.kind === "olympiads" && !options.legacy
                  ? olympiadSummary(r)
                  : r,
          ),
          progress,
          profile: { name: null, photo: null, max: false, admin: false, ...options.profile },
          features: { runner: false, max: false, reminders: false, ...options.features },
        }),
      );
    },
    async session() {
      calls.push({ action: "session", payload: {} });
      return { sessionToken: "test-token" };
    },
    getToken: () => "test-token",
    setToken: () => undefined,
  };
  return api;
}
