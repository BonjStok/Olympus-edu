import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import type { BootstrapResponse, ContentRecord, Olympiad, Task } from "@/lib/domain/types";
import { readSeedBundle } from "../../scripts/seed.mjs";
import { FIXTURE_RECORDS, FX } from "../support/fixtures";
import {
  adminToken,
  bootstrap,
  configureEnv,
  guestToken,
  resetDatabase,
  rpc,
} from "../support/server";

const DRAFTS = [
  {
    kind: "topics",
    id: "draft-topic",
    title: "Черновая тема",
    grade: 4,
    subject: "math",
    order: 99,
  },
  {
    kind: "lessons",
    id: "draft-lesson",
    title: "Черновой урок",
    topicId: FX.mathTopic,
    order: 9,
    blocks: [{ type: "text", value: "секрет" }],
  },
  {
    kind: "tasks",
    id: "draft-task",
    title: "Черновая задача",
    topicId: FX.mathTopic,
    type: "number",
    prompt: "2+2?",
    answer: "4",
    solution: "четыре",
    order: 9,
  },
  {
    kind: "olympiads",
    id: "draft-olympiad",
    title: "Черновая олимпиада",
    subject: "math",
    grades: [4],
    format: "online",
    region: "",
    deadline: "expected",
    date: "expected",
    url: "",
  },
  {
    kind: "mock-tests",
    id: "draft-mock",
    title: "Черновой пробник",
    olympiad: "Тест",
    grade: 4,
    subject: "math",
    minutes: 10,
    taskIds: [FX.numbers[0].id],
  },
];

const [n1] = FX.numbers;
const code1 = FX.code[0];
/** Published tasks of the fixture math topic in the order a child sees them. */
const mathTasks = FIXTURE_RECORDS.filter(
  (record): record is Task => record.kind === "tasks" && record.topicId === FX.mathTopic,
).sort((a, b) => a.order - b.order);

let admin: string;

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  configureEnv();
  admin = await adminToken(POST);
  for (const record of DRAFTS) {
    const response = await rpc(POST, "draft", { record }, { token: admin });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }
});
beforeEach(() => configureEnv());

describe("topic content and lessons", () => {
  it("returns published lessons and tasks without answers, ordered", async () => {
    const token = await guestToken(POST);
    const response = await rpc<{
      lessons: { id: string; order: number }[];
      tasks: Record<string, unknown>[];
    }>(POST, "topic-content", { id: FX.mathTopic }, { token });
    expect(response.status).toBe(200);
    expect(response.body.lessons.map((lesson) => lesson.id)).toEqual(FX.mathLessons);
    expect(response.body.tasks.map((task) => task.id)).toEqual(mathTasks.map((task) => task.id));
    for (const task of response.body.tasks) {
      expect(task).not.toHaveProperty("answer");
      expect(task).not.toHaveProperty("solution");
      expect(task).not.toHaveProperty("hint");
      expect(task).not.toHaveProperty("tests");
    }
  });

  it("marks lessons as read and awards the theory star only after all lessons", async () => {
    const token = await guestToken(POST);
    const early = await rpc(POST, "star", { id: FX.mathTopic }, { token });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("LESSONS_NOT_READ");
    const [last, ...others] = [...FX.mathLessons].reverse();
    for (const id of others)
      expect((await rpc(POST, "view-lesson", { id }, { token })).status).toBe(200);
    // One lesson short is still not enough.
    expect((await rpc(POST, "star", { id: FX.mathTopic }, { token })).body.code).toBe(
      "LESSONS_NOT_READ",
    );
    expect((await rpc(POST, "view-lesson", { id: last }, { token })).status).toBe(200);
    expect((await rpc(POST, "star", { id: FX.mathTopic }, { token })).status).toBe(200);
    const key = `theory-star:${FX.mathTopic}`;
    const first = (await bootstrap<BootstrapResponse>(GET, { token })).body.progress[key] as {
      date: number;
      type: string;
    };
    expect(first).toMatchObject({ type: "theory", subject: "math" });
    // Idempotent: the first date is kept.
    await rpc(POST, "star", { id: FX.mathTopic }, { token });
    const again = (await bootstrap<BootstrapResponse>(GET, { token })).body.progress[key];
    expect(again).toEqual(first);
  });

  it("refuses a theory star for a topic without lessons", async () => {
    const response = await rpc(POST, "star", { id: "draft-topic" }, { token: admin });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("TOPIC_HAS_NO_LESSONS");
  });

  it("validates ids", async () => {
    const token = await guestToken(POST);
    const missing = await rpc(POST, "view-lesson", {}, { token });
    expect(missing).toMatchObject({ status: 400, body: { code: "INVALID_ID" } });
    const bad = await rpc(POST, "view-lesson", { id: "../etc/passwd" }, { token });
    expect(bad).toMatchObject({ status: 400, body: { code: "INVALID_ID" } });
    const wrongKind = await rpc(POST, "view-lesson", { id: n1.id }, { token });
    expect(wrongKind).toMatchObject({ status: 404, body: { code: "LESSON_NOT_FOUND" } });
  });
});

describe("visibility of drafts and deleted records", () => {
  it.each([
    ["topic-content", { id: "draft-topic" }, "TOPIC_NOT_FOUND"],
    ["view-lesson", { id: "draft-lesson" }, "LESSON_NOT_FOUND"],
    ["star", { id: "draft-topic" }, "TOPIC_NOT_FOUND"],
    ["check", { id: "draft-task", answer: "4" }, "TASK_NOT_FOUND"],
    ["run", { id: "draft-task", code: "", language: "python" }, "TASK_NOT_FOUND"],
    ["reveal", { id: "draft-task" }, "TASK_NOT_FOUND"],
    ["hint", { id: "draft-task" }, "TASK_NOT_FOUND"],
    ["code-draft", { id: "draft-task", code: "", language: "python" }, "TASK_NOT_FOUND"],
    ["register", { id: "draft-olympiad", yes: true }, "OLYMPIAD_NOT_FOUND"],
    ["olympiad", { id: "draft-olympiad" }, "OLYMPIAD_NOT_FOUND"],
    ["start-mock", { id: "draft-mock" }, "MOCK_NOT_FOUND"],
  ])("%s on a draft answers 404 to a child", async (action, params, code) => {
    const token = await guestToken(POST);
    const response = await rpc(POST, action, params, { token });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe(code);
  });

  it("never lists drafts for children, but shows them to admins", async () => {
    const child = await bootstrap<BootstrapResponse>(GET, { token: await guestToken(POST) });
    const ids = new Set(child.body.records.map((record) => record.id));
    for (const draft of DRAFTS) expect(ids.has(draft.id)).toBe(false);
    const topic = await rpc<{ tasks: { id: string }[]; lessons: { id: string }[] }>(
      POST,
      "topic-content",
      { id: FX.mathTopic },
      { token: await guestToken(POST) },
    );
    expect(topic.body.tasks.map((task) => task.id)).not.toContain("draft-task");
    expect(topic.body.lessons.map((lesson) => lesson.id)).not.toContain("draft-lesson");

    const adminView = await bootstrap<BootstrapResponse>(GET, { token: admin });
    const draftTopic = adminView.body.records.find((record) => record.id === "draft-topic");
    expect(draftTopic).toMatchObject({ unpublished: true, draft: { id: "draft-topic" } });
  });

  it("lets admins preview a draft task", async () => {
    const response = await rpc(POST, "reveal", { id: "draft-task" }, { token: admin });
    expect(response).toMatchObject({ status: 200, body: { answer: "4", solution: "четыре" } });
  });

  it("hides deleted records from everybody", async () => {
    await rpc(
      POST,
      "publish",
      { record: { ...DRAFTS[3], id: "gone-olympiad", title: "Удалённая" } },
      { token: admin },
    );
    expect((await rpc(POST, "delete", { id: "gone-olympiad" }, { token: admin })).status).toBe(200);
    for (const token of [admin, await guestToken(POST)]) {
      const response = await rpc(POST, "register", { id: "gone-olympiad", yes: true }, { token });
      expect(response.status).toBe(404);
    }
  });
});

describe("registration", () => {
  it("sets and clears the registration mark", async () => {
    const token = await guestToken(POST);
    const id = FX.olympiad.id;
    const yes = await rpc(POST, "register", { id, yes: true }, { token });
    expect(yes.body).toEqual({ ok: true, registered: true });
    let me = await bootstrap<BootstrapResponse>(GET, { token });
    expect(me.body.progress[`registration:${id}`]).toEqual({ registered: true });
    const no = await rpc(POST, "register", { id, yes: false }, { token });
    expect(no.body).toEqual({ ok: true, registered: false });
    me = await bootstrap<BootstrapResponse>(GET, { token });
    expect(me.body.progress).not.toHaveProperty(`registration:${id}`);
  });

  it("rejects unknown olympiads and non-boolean flags", async () => {
    const token = await guestToken(POST);
    expect(
      (await rpc(POST, "register", { id: FX.mathTopic, yes: true }, { token })).body.code,
    ).toBe("OLYMPIAD_NOT_FOUND");
    const bad = await rpc(POST, "register", { id: FX.olympiad.id, yes: "yes" }, { token });
    expect(bad).toMatchObject({ status: 422, body: { code: "INVALID_REGISTERED" } });
  });
});

describe("olympiad details", () => {
  const published = (readSeedBundle() as unknown as ContentRecord[]).find(
    (record): record is Olympiad =>
      record.kind === "olympiads" && !record.unpublished && !!record.description,
  )!;

  it("returns the complete published olympiad", async () => {
    const token = await guestToken(POST);
    const response = await rpc(POST, "olympiad", { id: published.id }, { token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ olympiad: published });
  });

  it("hides deleted olympiads from everybody, lets a teacher preview a draft", async () => {
    await rpc(
      POST,
      "publish",
      { record: { ...DRAFTS[3], id: "details-gone", title: "Удалённая олимпиада" } },
      { token: admin },
    );
    await rpc(POST, "delete", { id: "details-gone" }, { token: admin });
    for (const token of [admin, await guestToken(POST)]) {
      const response = await rpc(POST, "olympiad", { id: "details-gone" }, { token });
      expect(response).toMatchObject({ status: 404, body: { code: "OLYMPIAD_NOT_FOUND" } });
    }
    // Children get 404 for the draft (see the table above); the teacher sees it.
    const preview = await rpc<{ olympiad: Olympiad }>(
      POST,
      "olympiad",
      { id: "draft-olympiad" },
      { token: admin },
    );
    expect(preview.body.olympiad).toMatchObject({ id: "draft-olympiad", unpublished: true });
  });

  it("answers 404 for unknown ids and other kinds, 400 for bad ids, 401 without a session", async () => {
    const token = await guestToken(POST);
    for (const id of ["no-such-olympiad", FX.mathTopic]) {
      const response = await rpc(POST, "olympiad", { id }, { token });
      expect(response).toMatchObject({ status: 404, body: { code: "OLYMPIAD_NOT_FOUND" } });
    }
    expect(await rpc(POST, "olympiad", { id: "../x" }, { token })).toMatchObject({
      status: 400,
      body: { code: "INVALID_ID" },
    });
    expect(await rpc(POST, "olympiad", { id: published.id })).toMatchObject({
      status: 401,
      body: { code: "SESSION_EXPIRED" },
    });
  });
});

describe("settings", () => {
  it("merges partial updates and clears fields with null", async () => {
    const token = await guestToken(POST);
    const first = await rpc(
      POST,
      "settings",
      { region: "Республика Алтай", grade: 5, subject: "info" },
      { token },
    );
    expect(first.body).toEqual({
      ok: true,
      settings: { region: "Республика Алтай", grade: 5, subject: "info" },
    });
    const second = await rpc(POST, "settings", { grade: null, region: "" }, { token });
    expect(second.body).toEqual({ ok: true, settings: { region: "", subject: "info" } });
    const me = await bootstrap<BootstrapResponse>(GET, { token });
    expect(me.body.progress.settings).toEqual({ region: "", subject: "info" });
  });

  it.each([[{ region: "Атлантида" }], [{ grade: 7 }], [{ grade: "5" }], [{ subject: "history" }]])(
    "rejects %j",
    async (params) => {
      const token = await guestToken(POST);
      const response = await rpc(POST, "settings", params, { token });
      expect(response).toMatchObject({ status: 422, body: { code: "INVALID_SETTINGS" } });
    },
  );
});

describe("code drafts", () => {
  it("saves drafts of code tasks only, with a valid language and size", async () => {
    const token = await guestToken(POST);
    const ok = await rpc(
      POST,
      "code-draft",
      { id: code1.id, code: "print(1)", language: "python" },
      { token },
    );
    expect(ok.body).toEqual({ ok: true });
    const me = await bootstrap<BootstrapResponse>(GET, { token });
    expect(me.body.progress[`code:${code1.id}`]).toEqual({
      code: "print(1)",
      language: "python",
    });

    // Number tasks, including «Что выведет программа?» tasks of informatics, have no code.
    for (const id of [n1.id, FX.trace.id]) {
      const notCode = await rpc(
        POST,
        "code-draft",
        { id, code: "x", language: "python" },
        { token },
      );
      expect(notCode).toMatchObject({ status: 400, body: { code: "NOT_CODE_TASK" } });
    }
    const language = await rpc(
      POST,
      "code-draft",
      { id: code1.id, code: "x", language: "ruby" },
      { token },
    );
    expect(language).toMatchObject({ status: 422, body: { code: "INVALID_LANGUAGE" } });
    const long = await rpc(
      POST,
      "code-draft",
      { id: code1.id, code: "x".repeat(50_001), language: "python" },
      { token },
    );
    expect(long).toMatchObject({ status: 422, body: { code: "INVALID_CODE" } });
    const missing = await rpc(POST, "code-draft", { id: code1.id, language: "python" }, { token });
    expect(missing).toMatchObject({ status: 422, body: { code: "INVALID_CODE" } });
  });
});
