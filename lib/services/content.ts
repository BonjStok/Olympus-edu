import type {
  AdminRecord,
  ApiErrorCode,
  ContentRecord,
  ContentSummary,
  Lesson,
  LessonSummary,
  Olympiad,
  OlympiadSummary,
  PublicTask,
  RecordKind,
  RecordSummary,
  ReviewedTask,
  Task,
  TaskSummary,
  Topic,
} from "@/lib/domain/types";
import { parseJson, type Db } from "@/lib/server/db";
import { notFound } from "@/lib/server/errors";
import type { Actor } from "./context";

type RecordOfKind<K extends RecordKind> = Extract<ContentRecord, { kind: K }>;

const NOT_FOUND: Record<RecordKind, { code: ApiErrorCode; message: string }> = {
  topics: { code: "TOPIC_NOT_FOUND", message: "Тема не найдена" },
  lessons: { code: "LESSON_NOT_FOUND", message: "Урок не найден" },
  tasks: { code: "TASK_NOT_FOUND", message: "Задание не найдено" },
  olympiads: { code: "OLYMPIAD_NOT_FOUND", message: "Олимпиада не найдена" },
  "mock-tests": { code: "MOCK_NOT_FOUND", message: "Пробник не найден" },
};

export function notFoundError(kind: RecordKind) {
  return notFound(NOT_FOUND[kind].message, NOT_FOUND[kind].code);
}

// ---------------------------------------------------------------------------
// Projections: what a child is allowed to see
// ---------------------------------------------------------------------------

/** Task before it is solved: no answer, solution, hint or hidden tests. */
export function publicTask(task: Task): PublicTask {
  const { answer: _answer, solution: _solution, hint: _hint, tests: _tests, ...rest } = task;
  return rest;
}

/** Task after a mock test is finished: answer and solution are shown, hidden tests never are. */
export function reviewedTask(task: Task): ReviewedTask {
  const { tests: _tests, ...rest } = task;
  return rest;
}

/**
 * List entry of `GET /api/v1/content`: lessons and tasks without their bodies, other records
 * complete. The evaluator API (openapi.yaml) keeps this shape.
 */
export function publicSummary(record: ContentRecord): ContentSummary {
  if (record.kind === "lessons") {
    const summary: LessonSummary = {
      id: record.id,
      kind: record.kind,
      title: record.title,
      grade: record.grade,
      subject: record.subject,
      topicId: record.topicId,
      order: record.order,
      unpublished: record.unpublished,
    };
    return summary;
  }
  if (record.kind === "tasks") {
    const summary: TaskSummary = {
      id: record.id,
      kind: record.kind,
      title: record.title,
      grade: record.grade,
      subject: record.subject,
      topicId: record.topicId,
      order: record.order,
      type: record.type,
      points: record.points,
      unpublished: record.unpublished,
    };
    return summary;
  }
  return record;
}

/** Olympiad without the fields that only its details screen shows (action `olympiad`). */
export function olympiadSummary(olympiad: Olympiad): OlympiadSummary {
  const {
    description: _description,
    source: _source,
    verifiedAt: _verifiedAt,
    image: _image,
    ...rest
  } = olympiad;
  return rest;
}

/** List entry of the children's catalogue (`GET /api/olympus`): olympiads are slimmed down too. */
export function catalogueSummary(record: ContentRecord): RecordSummary {
  return record.kind === "olympiads" ? olympiadSummary(record) : publicSummary(record);
}

export function isVisibleTo(record: ContentRecord, actor: Pick<Actor, "admin">): boolean {
  return !record.unpublished || actor.admin;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

interface RecordRow {
  id: string;
  kind: string;
  data: string;
  draft: string | null;
  deleted: number;
}

/** The current (published or draft-only) version of a non-deleted record. */
export async function findRecord(db: Db, id: string): Promise<ContentRecord | null> {
  const row = await db.one<Pick<RecordRow, "data">>(
    "SELECT data FROM records WHERE id = $1 AND deleted = 0",
    [id],
  );
  return parseJson<ContentRecord>(row?.data);
}

/**
 * Loads a record of the expected kind that the actor may see. Missing, deleted, unpublished (for
 * non-admins) and wrong-kind records all produce the same 404, so drafts cannot be probed.
 */
export async function requireRecord<K extends RecordKind>(
  db: Db,
  id: string,
  kind: K,
  actor: Pick<Actor, "admin">,
): Promise<RecordOfKind<K>> {
  const record = await findRecord(db, id);
  if (!record || record.kind !== kind || !isVisibleTo(record, actor)) throw notFoundError(kind);
  return record as RecordOfKind<K>;
}

async function allRecords(db: Db): Promise<RecordRow[]> {
  return db.query<RecordRow>(
    "SELECT id, kind, data, draft, deleted FROM records WHERE deleted = 0 ORDER BY updated, id",
  );
}

async function listPublished<T>(db: Db, project: (record: ContentRecord) => T): Promise<T[]> {
  const rows = await allRecords(db);
  const summaries: T[] = [];
  for (const row of rows) {
    const record = parseJson<ContentRecord>(row.data);
    if (record && !record.unpublished) summaries.push(project(record));
  }
  return summaries;
}

/** `GET /api/v1/content`: published records, heavy fields of lessons/tasks omitted. */
export function listPublicSummaries(db: Db): Promise<ContentSummary[]> {
  return listPublished(db, publicSummary);
}

/**
 * Children's catalogue of `GET /api/olympus`: published records, heavy fields of lessons, tasks
 * and olympiads omitted. Served through the per-isolate cache of `./catalogue`.
 */
export function listCatalogue(db: Db): Promise<RecordSummary[]> {
  return listPublished(db, catalogueSummary);
}

/** Admin catalogue: every non-deleted record with its pending draft. */
export async function listAdminRecords(db: Db): Promise<AdminRecord[]> {
  const rows = await allRecords(db);
  return rows.map((row) => ({
    ...(parseJson<ContentRecord>(row.data) as ContentRecord),
    draft: parseJson<ContentRecord>(row.draft),
  }));
}

const byOrder = (a: { order?: number }, b: { order?: number }) =>
  (Number(a.order) || 0) - (Number(b.order) || 0);

/** Published lessons and tasks of a topic, ordered by `order`. */
export async function topicChildren(
  db: Db,
  topicId: string,
): Promise<{ lessons: Lesson[]; tasks: Task[] }> {
  const rows = await db.query<Pick<RecordRow, "data">>(
    `SELECT data FROM records
      WHERE deleted = 0 AND kind IN ('lessons', 'tasks') AND (data::jsonb ->> 'topicId') = $1
      ORDER BY updated, id`,
    [topicId],
  );
  const lessons: Lesson[] = [];
  const tasks: Task[] = [];
  for (const row of rows) {
    const record = parseJson<ContentRecord>(row.data);
    if (!record || record.unpublished) continue;
    if (record.kind === "lessons") lessons.push(record);
    if (record.kind === "tasks") tasks.push(record);
  }
  return { lessons: lessons.sort(byOrder), tasks: tasks.sort(byOrder) };
}

export async function getTopicContent(
  db: Db,
  topicId: string,
  actor: Pick<Actor, "admin">,
): Promise<{ topic: Topic; lessons: Lesson[]; tasks: PublicTask[] }> {
  const topic = await requireRecord(db, topicId, "topics", actor);
  const { lessons, tasks } = await topicChildren(db, topicId);
  return { topic, lessons, tasks: tasks.map(publicTask) };
}
