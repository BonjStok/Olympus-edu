/**
 * E2E helpers. Tests never rely on particular demo records or on today's date: everything
 * they need (an olympiad, a region, a topic with its answers, a mock) is picked at run time
 * from what the running server publishes (`GET /api/olympus`) plus the answers in
 * `lib/seed.json`. When the calendar has aged and no record fits any more, the chosen record's
 * dates are moved relative to today in the browser (and the test says so in its annotations).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type {
  ContentRecord,
  LessonSummary,
  MockTest,
  OlympiadSummary,
  RecordSummary,
  Task,
  TaskSummary,
  Topic,
} from "../../lib/domain/types";

// ----------------------------------------------------------------------------- browser setup

/**
 * Every test starts as a new guest in a fresh context. The MAX Bridge script is replaced by
 * `bridge` (empty = a plain browser) and every request to another site gets an empty page, so
 * tests never depend on st.max.ru or on the olympiad organisers' sites.
 */
export async function prepare(context: BrowserContext, bridge = "") {
  const base = new URL(test.info().project.use.baseURL ?? "http://localhost:3000");
  await context.route(
    (url) => url.origin !== base.origin,
    (route) =>
      route.request().url().startsWith("https://st.max.ru/")
        ? route.fulfill({ contentType: "text/javascript", body: bridge })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html><title>ok</title>" }),
  );
}

/** Skips onboarding with the given class/subject/region already chosen. */
export async function presetLearner(
  context: BrowserContext,
  settings: { grade: 4 | 5 | 6; subject: "math" | "info"; region?: string },
) {
  await context.addInitScript(
    (s) => localStorage.setItem("olympus.settings", JSON.stringify({ onboarded: true, ...s })),
    settings,
  );
}

/** Text for a `RegExp` that matches `text` literally (region names contain brackets). */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function screenTitle(page: Page, name: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 20_000 });
}

/** Tab bar on phones, sidebar on desktop – whichever is visible. */
export async function openTab(page: Page, name: string) {
  await page
    .locator("button.ol-nav-item")
    .filter({ visible: true })
    .filter({ has: page.getByText(name, { exact: true }) })
    .first()
    .click();
}

export async function finishOnboarding(
  page: Page,
  opts: { grade: string; subject: string; region?: string },
) {
  await expect(page.getByRole("heading", { name: "Привет! Я Олимпус" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("radio", { name: opts.grade }).click();
  await page.getByRole("radio", { name: opts.subject }).click();
  if (opts.region) await pickRegion(page, page.getByRole("combobox"), opts.region);
  await page.getByRole("button", { name: "Начать" }).click();
  await screenTitle(page, /^Привет/);
}

/** Types the start of a region into a region combobox and picks it from the list. */
export async function pickRegion(page: Page, input: ReturnType<Page["getByRole"]>, region: string) {
  await input.click();
  await input.fill(region.replace(/^(Республика|Город)\s+/, "").slice(0, 6));
  await page.getByRole("option", { name: region, exact: true }).click();
  await expect(input).toHaveValue(region);
}

/** Opens every collapsed section of the olympiad list («Регистрация закрыта», «Прошедшие»). */
export async function expandCollapsedSections(page: Page) {
  const collapsed = page.locator("button.ol-collapse-btn[aria-expanded=false]");
  while ((await collapsed.count()) > 0) await collapsed.first().click();
}

/** Mock timer text («59:58», «1:00:00») in seconds. */
export function timerSeconds(text: string): number {
  const parts = text.trim().split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// ----------------------------------------------------------------------------- content

/** Today in Moscow as `YYYY-MM-DD` – the calendar's time zone. */
export function moscowToday(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && ISO_DAY.test(v);

let seedCache: ContentRecord[] | null = null;
function seed(): ContentRecord[] {
  seedCache ??= JSON.parse(
    readFileSync(path.join(process.cwd(), "lib", "seed.json"), "utf8"),
  ) as ContentRecord[];
  return seedCache;
}

export interface Content {
  records: RecordSummary[];
  today: string;
}

/** What the running server publishes to a child right now. */
export async function loadContent(request: APIRequestContext): Promise<Content> {
  const res = await request.get("/api/olympus");
  expect(res.ok(), "GET /api/olympus").toBe(true);
  const body = (await res.json()) as { records: RecordSummary[] };
  return { records: body.records.filter((r) => !r.unpublished), today: moscowToday() };
}

function fullTask(id: string): Task {
  const task = seed().find((r): r is Task => r.id === id && r.kind === "tasks");
  if (!task) throw new Error(`Task ${id} is published but missing from lib/seed.json`);
  return task;
}

const olympiads = (c: Content) =>
  c.records.filter((r): r is OlympiadSummary => r.kind === "olympiads");
const notPast = (e: OlympiadSummary, today: string) =>
  !isDay(e.date) || (isDay(e.dateEnd) ? e.dateEnd : e.date) >= today;
const registrationOpen = (e: OlympiadSummary, today: string) =>
  notPast(e, today) &&
  (!isDay(e.registrationStart) || e.registrationStart <= today) &&
  (!isDay(e.deadline) || e.deadline >= today);

/** An olympiad chosen for a test, with date fixes to apply when the calendar has aged. */
export interface Picked {
  event: OlympiadSummary;
  patch?: Partial<OlympiadSummary>;
}

/**
 * A regional edition of the ВсОШ school stage in math for 5th grade (registration through the
 * school), preferably upcoming and preferably in Tatarstan.
 */
export function pickSchoolStage(c: Content): Picked {
  const all = olympiads(c).filter(
    (e) =>
      e.series?.startsWith("vsosh-school") &&
      e.subject === "math" &&
      e.grades.includes(5) &&
      e.region &&
      e.registrationType === "school",
  );
  if (!all.length) throw new Error("No ВсОШ school-stage olympiads are published");
  const upcoming = all.filter((e) => isDay(e.date) && e.date >= c.today);
  const pool = upcoming.length ? upcoming : all;
  const event = pool.find((e) => e.region === "Республика Татарстан") ?? pool[0];
  return upcoming.length
    ? { event }
    : { event, patch: { date: addDays(c.today, 14), dateEnd: undefined } };
}

/** An all-Russia 5th-grade math olympiad with registration on the organiser's site. */
export function pickLinkOlympiad(c: Content): Picked {
  const all = olympiads(c).filter(
    (e) =>
      !e.region &&
      e.registrationType !== "school" &&
      e.url &&
      e.subject === "math" &&
      e.grades.includes(5) &&
      isDay(e.date),
  );
  if (!all.length) throw new Error("No all-Russia olympiads with a registration link");
  const open = all.filter((e) => registrationOpen(e, c.today));
  const event = open.find((e) => isDay(e.deadline)) ?? open[0];
  if (event) return { event };
  return {
    event: all[0],
    patch: {
      registrationStart: undefined,
      deadline: addDays(c.today, 7),
      date: addDays(c.today, 14),
      dateEnd: undefined,
    },
  };
}

/** Number of regions a series is held in (for the collapsed card «в N регионах»). */
export function seriesRegions(c: Content, series: string): number {
  return new Set(
    olympiads(c)
      .filter((e) => e.series === series && e.grades.includes(5))
      .map((e) => e.region),
  ).size;
}

/** Serves the picked olympiads with their date fixes (if any) to every page of the context. */
export async function serveOlympiads(context: BrowserContext, picked: Picked[]) {
  const patches = new Map(picked.filter((p) => p.patch).map((p) => [p.event.id, p.patch]));
  if (!patches.size) return;
  test.info().annotations.push({
    type: "dates moved",
    description: `The calendar has aged: dates of ${[...patches.keys()].join(", ")} were moved to after today`,
  });
  await context.route(/\/api\/olympus$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const data = (await response.json()) as { records: RecordSummary[] };
    data.records = data.records.map((r) =>
      patches.has(r.id) ? ({ ...r, ...patches.get(r.id) } as RecordSummary) : r,
    );
    await route.fulfill({ response, json: data });
  });
}

export interface PickedTopic {
  topic: Topic;
  lessons: LessonSummary[];
  /** First task with a number answer, its index in the topic and its right answer. */
  task: Task;
  taskIndex: number;
}

/** The first topic of 5th-grade math (the one «Учёба» recommends to a new child). */
export function pickFirstTopic(c: Content): PickedTopic {
  const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
  const topic = c.records
    .filter((r): r is Topic => r.kind === "topics" && r.grade === 5 && r.subject === "math")
    .sort(byOrder)[0];
  if (!topic) throw new Error("No 5th-grade math topics are published");
  const lessons = c.records
    .filter((r): r is LessonSummary => r.kind === "lessons" && r.topicId === topic.id)
    .sort(byOrder);
  const tasks = c.records
    .filter((r): r is TaskSummary => r.kind === "tasks" && r.topicId === topic.id)
    .sort(byOrder);
  const taskIndex = tasks.findIndex((t) => t.type === "number");
  if (taskIndex < 0) throw new Error(`Topic ${topic.id} has no number tasks`);
  return { topic, lessons, task: fullTask(tasks[taskIndex].id), taskIndex };
}

export interface PickedMock {
  mock: MockTest;
  tasks: Task[];
  /** First task with a number answer and its position in the attempt. */
  task: Task;
  taskIndex: number;
  maxScore: number;
}

/** «Пробный тур» of 5th-grade math: fixed tasks, so the score is known in advance. */
export function pickMock(c: Content): PickedMock {
  const mock = c.records
    .filter(
      (r): r is MockTest =>
        r.kind === "mock-tests" && r.grade === 5 && r.subject === "math" && !r.randomize,
    )
    .sort((a, b) => a.title.localeCompare(b.title))[0];
  if (!mock) throw new Error("No fixed 5th-grade math mock is published");
  const tasks = mock.taskIds.map(fullTask).filter((t) => !t.unpublished);
  const taskIndex = tasks.findIndex((t) => t.type === "number");
  if (taskIndex < 0) throw new Error(`Mock ${mock.id} has no number tasks`);
  return {
    mock,
    tasks,
    task: tasks[taskIndex],
    taskIndex,
    maxScore: tasks.reduce((sum, t) => sum + (t.points ?? 1), 0),
  };
}

/** A wrong but well-formed answer to a number task. */
export function wrongAnswer(answer: string): string {
  const n = Number(answer.replace(",", "."));
  return Number.isFinite(n) ? String(n + 1) : "0";
}

/** First paragraph of a task statement as the child sees it. */
export function promptStart(task: Task): string {
  return task.prompt.split(/\n{2,}|```/)[0].trim();
}
