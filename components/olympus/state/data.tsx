"use client";
/**
 * App data: bootstrap (records, progress, profile, features), topic contents,
 * user settings, and all server actions with optimistic progress updates.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  AdminRecord,
  CodeLanguage,
  ContentRecord,
  Features,
  Lesson,
  LessonSummary,
  MockAnswer,
  MockAttempt,
  MockTest,
  Olympiad,
  OlympiadSummary,
  Profile,
  ProgressMap,
  PublicTask,
  RecordSummary,
  Task,
  TaskProgress,
  TaskSummary,
  Topic,
  UserSettings,
} from "@/lib/domain/types";
import { errorMessage, isUnknownAction, type ApiClient, type CallOptions } from "@/lib/client/api";
import { noteServerNow } from "@/lib/client/clock";
import * as bridge from "@/lib/client/max-bridge";
import { localStore } from "@/lib/client/storage";
import { readSettings } from "@/lib/ui/progress";

export interface TopicContent {
  lessons: Lesson[];
  tasks: PublicTask[];
}

/** Server settings plus preferences kept only on this device. */
export interface LocalSettings extends UserSettings {
  /** «Обе» in onboarding: calendar and mocks are not filtered by subject. */
  bothSubjects?: boolean;
  /** The first-run screen was completed or skipped. */
  onboarded?: boolean;
}

/** Last place in «Учёба» for «Продолжить». */
export interface LastTopic {
  id: string;
  part: "theory" | "practice";
  step: number;
  at: number;
}

interface DataState {
  status: "loading" | "ready" | "error";
  error: string | null;
  records: (RecordSummary | AdminRecord)[];
  progress: ProgressMap;
  profile: Profile;
  features: Features;
  topics: Record<string, TopicContent>;
  /** Complete olympiads (description, source…) loaded by their details screen, by id. */
  olympiadDetails: Record<string, Olympiad>;
  settings: LocalSettings;
  /** MAX sign-in failed; the app works as a guest. */
  signInError: string | null;
  /** Deep link from MAX to open once after loading. */
  startParam: string | null;
}

type DataAction =
  | { type: "loading" }
  | {
      type: "loaded";
      records: DataState["records"];
      progress: ProgressMap;
      profile: Profile;
      features: Features;
      settings: LocalSettings;
    }
  | { type: "failed"; error: string }
  | { type: "progress"; key: string; value: unknown }
  | { type: "topic"; id: string; content: TopicContent }
  | { type: "olympiad"; olympiad: Olympiad }
  | { type: "settings"; settings: LocalSettings }
  | { type: "signInError"; error: string | null }
  | { type: "startParam"; value: string | null };

const EMPTY_PROFILE: Profile = { name: null, photo: null, max: false, admin: false };
const NO_FEATURES: Features = { runner: false, max: false, reminders: false, botName: null };
export const SETTINGS_KEY = "olympus.settings";
export const LAST_TOPIC_KEY = "olympus.lastTopic";

function reducer(state: DataState, action: DataAction): DataState {
  switch (action.type) {
    case "loading":
      return { ...state, status: state.status === "ready" ? "ready" : "loading", error: null };
    case "loaded":
      return {
        ...state,
        status: "ready",
        error: null,
        records: action.records,
        progress: action.progress,
        profile: action.profile,
        features: action.features,
        settings: action.settings,
      };
    case "failed":
      return {
        ...state,
        status: state.status === "ready" ? "ready" : "error",
        error: action.error,
      };
    case "progress": {
      const progress = { ...state.progress };
      if (action.value === undefined) delete progress[action.key];
      else progress[action.key] = action.value;
      return { ...state, progress };
    }
    case "topic":
      return { ...state, topics: { ...state.topics, [action.id]: action.content } };
    case "olympiad":
      return {
        ...state,
        olympiadDetails: { ...state.olympiadDetails, [action.olympiad.id]: action.olympiad },
      };
    case "settings":
      return { ...state, settings: action.settings };
    case "signInError":
      return { ...state, signInError: action.error };
    case "startParam":
      return { ...state, startParam: action.value };
  }
}

const INITIAL: DataState = {
  status: "loading",
  error: null,
  records: [],
  progress: {},
  profile: EMPTY_PROFILE,
  features: NO_FEATURES,
  topics: {},
  olympiadDetails: {},
  settings: {},
  signInError: null,
  startParam: null,
};

function mergeSettings(server: UserSettings): LocalSettings {
  const local = localStore.getJSON<LocalSettings>(SETTINGS_KEY) ?? {};
  const merged: LocalSettings = { ...local };
  if (typeof server.region === "string") merged.region = server.region;
  if (server.grade === 4 || server.grade === 5 || server.grade === 6) merged.grade = server.grade;
  if (server.subject === "math" || server.subject === "info") merged.subject = server.subject;
  // Settings that came from another device mean the first run is already done.
  if (merged.grade) merged.onboarded = true;
  return merged;
}

/** Only the fields the server knows about. */
function serverSettings(s: LocalSettings): UserSettings {
  const out: UserSettings = {};
  if (typeof s.region === "string") out.region = s.region;
  if (s.grade) out.grade = s.grade;
  if (s.subject) out.subject = s.subject;
  return out;
}

function useDataStore(api: ApiClient) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const setProgress = useCallback((key: string, value: unknown) => {
    dispatch({ type: "progress", key, value });
  }, []);

  const load = useCallback(async () => {
    dispatch({ type: "loading" });
    try {
      const b = await api.bootstrap();
      dispatch({
        type: "loaded",
        records: b.records,
        progress: b.progress,
        profile: b.profile,
        features: b.features,
        settings: mergeSettings(readSettings(b.progress)),
      });
      return true;
    } catch (e) {
      dispatch({ type: "failed", error: errorMessage(e) });
      return false;
    }
  }, [api]);

  /** First launch: exchange MAX initData for a session, then load everything. */
  const start = useCallback(async () => {
    dispatch({ type: "loading" });
    let startParam = bridge.startParam() ?? null;
    const init = bridge.initData();
    if (init) {
      try {
        const res = await api.session(init);
        if (res.startParam) startParam = res.startParam;
        dispatch({ type: "signInError", error: null });
      } catch (e) {
        dispatch({ type: "signInError", error: errorMessage(e) });
      }
    }
    dispatch({ type: "startParam", value: startParam });
    return load();
  }, [api, load]);

  const loadTopic = useCallback(
    async (id: string): Promise<TopicContent> => {
      const cached = stateRef.current.topics[id];
      if (cached) return cached;
      const content = await api.call("topic-content", { id });
      const sorted: TopicContent = {
        lessons: [...(content.lessons ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        tasks: [...(content.tasks ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      };
      dispatch({ type: "topic", id, content: sorted });
      return sorted;
    },
    [api],
  );

  /** The server answered that it has no `olympiad` action (an older version). */
  const olympiadUnsupported = useRef(false);

  /**
   * Complete olympiad for its details screen: the catalogue has summaries only. Cached for the
   * session. `null` when the server is older and has no `olympiad` action – the screen then
   * shows what the summary has.
   */
  const loadOlympiad = useCallback(
    async (id: string): Promise<Olympiad | null> => {
      const cached = stateRef.current.olympiadDetails[id];
      if (cached) return cached;
      if (olympiadUnsupported.current) return null;
      try {
        const { olympiad } = await api.call("olympiad", { id });
        if (!olympiad || olympiad.id !== id) return null;
        dispatch({ type: "olympiad", olympiad });
        return olympiad;
      } catch (e) {
        if (!isUnknownAction(e)) throw e;
        olympiadUnsupported.current = true;
        return null;
      }
    },
    [api],
  );

  /** «Урок прочитан» requests still on their way to the server. */
  const lessonReads = useRef(new Set<Promise<unknown>>());

  const markLessonRead = useCallback(
    async (id: string) => {
      const key = `lesson:${id}`;
      if (stateRef.current.progress[key]) return;
      setProgress(key, { read: true });
      const request = api.call("view-lesson", { id });
      lessonReads.current.add(request);
      try {
        await request;
      } catch (e) {
        setProgress(key, undefined);
        throw e;
      } finally {
        lessonReads.current.delete(request);
      }
    },
    [api, setProgress],
  );

  const claimTheoryStar = useCallback(
    async (topic: Pick<Topic, "id" | "title" | "subject">) => {
      // The last lesson is marked read on screen at once; the server gives the star only after
      // it has stored that lesson, so wait for the lesson requests first.
      await Promise.allSettled([...lessonReads.current]);
      await api.call("star", { id: topic.id });
      setProgress(`theory-star:${topic.id}`, {
        title: topic.title,
        subject: topic.subject,
        type: "theory",
        date: Date.now(),
      });
    },
    [api, setProgress],
  );

  /** Registration requests of one olympiad go one after another; only the last one counts. */
  const registrationQueue = useRef(new Map<string, { last: Promise<unknown>; seq: number }>());

  const setRegistration = useCallback(
    async (id: string, yes: boolean) => {
      const key = `registration:${id}`;
      const before = stateRef.current.progress[key];
      setProgress(key, yes ? { registered: true } : undefined);
      // «Я участвую» and «Убрать отметку» tapped quickly on a slow network: the server must see
      // them in this order, and a late answer to the first must not undo the second.
      const queue = registrationQueue.current;
      const previous = queue.get(key);
      const seq = (previous?.seq ?? 0) + 1;
      const request = (previous?.last ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => api.call("register", { id, yes }));
      queue.set(key, { last: request, seq });
      const latest = () => queue.get(key)?.seq === seq;
      try {
        const res = await request;
        if (latest() && typeof res?.registered === "boolean")
          setProgress(key, res.registered ? { registered: true } : undefined);
      } catch (e) {
        if (latest()) setProgress(key, before);
        throw e;
      }
    },
    [api, setProgress],
  );

  const checkTask = useCallback(
    async (
      task: Pick<Task, "id" | "title" | "topicId" | "subject" | "type">,
      payload: { answer?: string; correct?: boolean; code?: string; language?: CodeLanguage },
    ) => {
      const result = await api.call(
        "check",
        { id: task.id, ...payload },
        task.type === "code" ? { timeoutMs: 70_000 } : undefined,
      );
      const key = `task:${task.id}`;
      const old = stateRef.current.progress[key] as TaskProgress | undefined;
      const firstSolve = !!result.correct && !old?.correct;
      setProgress(key, {
        title: task.title,
        topicId: task.topicId,
        subject: task.subject,
        correct: !!(result.correct || old?.correct),
        lastCorrect: !!result.correct,
        attempts: (old?.attempts ?? 0) + 1,
        selfChecked: task.type === "proof",
        revealed: old?.revealed,
        solvedAfterReveal: old?.solvedAfterReveal || (firstSolve && !!old?.revealed),
      } satisfies TaskProgress);
      if (result.practiceStar) {
        const topic = stateRef.current.records.find((r) => r.id === task.topicId) as
          Topic | undefined;
        setProgress(`practice-star:${task.topicId}`, {
          title: topic?.title ?? task.title,
          subject: task.subject,
          type: "practice",
          date: Date.now(),
        });
      }
      return result;
    },
    [api, setProgress],
  );

  const revealTask = useCallback(
    async (task: Pick<Task, "id" | "title" | "topicId" | "subject" | "type">) => {
      const res = await api.call("reveal", { id: task.id });
      const key = `task:${task.id}`;
      const old = stateRef.current.progress[key] as TaskProgress | undefined;
      setProgress(key, {
        title: task.title,
        topicId: task.topicId,
        subject: task.subject,
        correct: !!old?.correct,
        lastCorrect: !!old?.lastCorrect,
        attempts: old?.attempts ?? 0,
        selfChecked: task.type === "proof",
        revealed: true,
        solvedAfterReveal: old?.solvedAfterReveal,
      } satisfies TaskProgress);
      return res;
    },
    [api, setProgress],
  );

  const hintFor = useCallback(async (id: string) => (await api.call("hint", { id })).hint, [api]);

  const saveCodeDraft = useCallback(
    async (id: string, code: string, language: CodeLanguage, opts?: CallOptions) => {
      setProgress(`code:${id}`, { code, language });
      await api.call("code-draft", { id, code, language }, opts);
    },
    [api, setProgress],
  );

  const putAttempt = useCallback(
    (attempt: MockAttempt) => setProgress(`attempt:${attempt.id}`, attempt),
    [setProgress],
  );

  const startMock = useCallback(
    async (test: Pick<MockTest, "id">) => {
      const { attempt } = await api.call("start-mock", { id: test.id });
      // The attempt was created just now by the server: its clock is the one that counts.
      noteServerNow(attempt.started);
      putAttempt(attempt);
      return attempt;
    },
    [api, putAttempt],
  );

  /** The server merges `mock-save` answers (patch) – known once `mock-get` works. */
  const mockPatch = useRef(false);

  /** Fresh attempt from the server (never trust a stale copy: answers could be lost). */
  const fetchAttempt = useCallback(
    async (attemptId: string): Promise<MockAttempt | null> => {
      try {
        const { attempt } = await api.call("mock-get", { id: attemptId });
        mockPatch.current = true;
        putAttempt(attempt);
        return attempt;
      } catch (e) {
        if (!isUnknownAction(e)) throw e;
      }
      // Older server: reload everything and take the attempt from progress.
      const b = await api.bootstrap();
      dispatch({
        type: "loaded",
        records: b.records,
        progress: b.progress,
        profile: b.profile,
        features: b.features,
        settings: stateRef.current.settings,
      });
      return (b.progress[`attempt:${attemptId}`] as MockAttempt | undefined) ?? null;
    },
    [api, putAttempt],
  );

  /**
   * Keeps answers locally right away, then saves them: only the changed ones when the
   * server merges, the whole map otherwise. Returns a finished attempt if time ran out.
   */
  const saveMockAnswers = useCallback(
    async (
      attemptId: string,
      answers: Record<string, MockAnswer>,
      changed: Record<string, MockAnswer>,
      opts?: CallOptions,
    ) => {
      const key = `attempt:${attemptId}`;
      const current = stateRef.current.progress[key] as MockAttempt | undefined;
      if (current && !current.finished) putAttempt({ ...current, answers });
      const payload = mockPatch.current ? changed : answers;
      const res = await api.call("mock-save", { id: attemptId, answers: payload }, opts);
      if (res && "attempt" in res && res.attempt) {
        putAttempt(res.attempt);
        return res.attempt;
      }
      return null;
    },
    [api, putAttempt],
  );

  const recheckMock = useCallback(
    async (attemptId: string) => {
      const { attempt } = await api.call("mock-recheck", { id: attemptId }, { timeoutMs: 90_000 });
      putAttempt(attempt);
      return attempt;
    },
    [api, putAttempt],
  );

  const finishMock = useCallback(
    async (attemptId: string, answers?: Record<string, MockAnswer>) => {
      const { attempt } = await api.call(
        "finish-mock",
        answers ? { id: attemptId, answers } : { id: attemptId },
        { timeoutMs: 90_000 },
      );
      putAttempt(attempt);
      return attempt;
    },
    [api, putAttempt],
  );

  const markMockProof = useCallback(
    async (attemptId: string, taskId: string, correct: boolean) => {
      const { attempt } = await api.call("mock-proof", { id: attemptId, taskId, correct });
      putAttempt(attempt);
      return attempt;
    },
    [api, putAttempt],
  );

  /** Saves preferences locally at once and on the server when it supports `settings`. */
  /** Settings requests go one after another, so the server keeps the child's last choice. */
  const settingsQueue = useRef<Promise<unknown>>(Promise.resolve());

  const updateSettings = useCallback(
    async (patch: LocalSettings) => {
      const before = stateRef.current.settings;
      const next = { ...before, ...patch };
      stateRef.current = { ...stateRef.current, settings: next };
      dispatch({ type: "settings", settings: next });
      localStore.setJSON(SETTINGS_KEY, next);
      const serverPart = serverSettings(next);
      if (JSON.stringify(serverPart) === JSON.stringify(serverSettings(before))) return;
      const request = settingsQueue.current
        .catch(() => undefined)
        .then(() => api.call("settings", serverPart));
      settingsQueue.current = request;
      try {
        await request;
      } catch (e) {
        if (!isUnknownAction(e)) throw e;
      }
    },
    [api],
  );

  const rememberTopic = useCallback((last: Omit<LastTopic, "at">) => {
    localStore.setJSON(LAST_TOPIC_KEY, { ...last, at: Date.now() } satisfies LastTopic);
  }, []);

  const consumeStartParam = useCallback(() => {
    const value = stateRef.current.startParam;
    if (value) dispatch({ type: "startParam", value: null });
    return value;
  }, []);

  return {
    state,
    api,
    load,
    start,
    loadTopic,
    loadOlympiad,
    markLessonRead,
    claimTheoryStar,
    setRegistration,
    checkTask,
    revealTask,
    hintFor,
    saveCodeDraft,
    startMock,
    fetchAttempt,
    saveMockAnswers,
    finishMock,
    recheckMock,
    markMockProof,
    updateSettings,
    rememberTopic,
    consumeStartParam,
    setProgress,
  };
}

export type DataStore = ReturnType<typeof useDataStore>;

const DataContext = createContext<DataStore | null>(null);

export function DataProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const store = useDataStore(api);
  return <DataContext.Provider value={store}>{children}</DataContext.Provider>;
}

export function useData(): DataStore {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData outside DataProvider");
  return ctx;
}

export interface Catalog {
  olympiads: OlympiadSummary[];
  topics: Topic[];
  mocks: MockTest[];
  lessonsByTopic: Map<string, LessonSummary[]>;
  tasksByTopic: Map<string, TaskSummary[]>;
  byId: Map<string, RecordSummary>;
}

const collator = new Intl.Collator("ru");

function byOrder<T extends { order?: number; title: string }>(a: T, b: T): number {
  return (a.order ?? 0) - (b.order ?? 0) || collator.compare(a.title, b.title);
}

/** Published records as a child sees them, grouped for the screens. */
export function buildCatalog(records: (RecordSummary | AdminRecord | ContentRecord)[]): Catalog {
  const visible = records.filter((r) => !r.unpublished) as RecordSummary[];
  const lessonsByTopic = new Map<string, LessonSummary[]>();
  const tasksByTopic = new Map<string, TaskSummary[]>();
  const olympiads: OlympiadSummary[] = [];
  const topics: Topic[] = [];
  const mocks: MockTest[] = [];
  for (const r of visible) {
    if (r.kind === "olympiads") olympiads.push(r);
    else if (r.kind === "topics") topics.push(r);
    else if (r.kind === "mock-tests") mocks.push(r);
    else if (r.kind === "lessons") {
      const list = lessonsByTopic.get(r.topicId) ?? [];
      list.push(r as LessonSummary);
      lessonsByTopic.set(r.topicId, list);
    } else if (r.kind === "tasks") {
      const list = tasksByTopic.get(r.topicId) ?? [];
      list.push(r as TaskSummary);
      tasksByTopic.set(r.topicId, list);
    }
  }
  for (const list of lessonsByTopic.values()) list.sort(byOrder);
  for (const list of tasksByTopic.values()) list.sort(byOrder);
  topics.sort(byOrder);
  return {
    olympiads,
    topics,
    mocks,
    lessonsByTopic,
    tasksByTopic,
    byId: new Map(visible.map((r) => [r.id, r])),
  };
}

export function useCatalog(): Catalog {
  const { state } = useData();
  return useMemo(() => buildCatalog(state.records), [state.records]);
}
