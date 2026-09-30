// Admin content management: drafts, publishing, bulk import, revisions, soft delete.
import type { ContentRecord, Olympiad, Revision } from "@/lib/domain/types";
import { regions } from "@/lib/content/regions.mjs";
import {
  ContentValidationError,
  findDuplicateOlympiad,
  linkedRecordIds,
  validateLinks,
  validateRecord,
} from "@/lib/content/validate.mjs";
import { parseJson, type Db } from "@/lib/server/db";
import { badRequest, conflict, notFound } from "@/lib/server/errors";
import { isPlainObject } from "@/lib/server/validate";
import type { ServiceContext } from "./context";

export const MAX_IMPORT_RECORDS = 1500;

/**
 * `updated` of an upserted row. Every write must raise it strictly – even when the request's
 * clock equals or lags the stored value – so that the content version of the children's
 * catalogue cache (lib/services/catalogue.ts) changes with every write.
 */
const RAISE_UPDATED = "GREATEST(excluded.updated, records.updated + 1)";

/** Validates one incoming record. Server-managed fields (`draft`, `unpublished`) are dropped. */
export function prepareIncoming(input: unknown): ContentRecord {
  if (!isPlainObject(input)) throw badRequest("Материал должен быть объектом", "VALIDATION_ERROR");
  const { draft: _draft, unpublished: _unpublished, ...rest } = input;
  try {
    return validateRecord(rest, { regions });
  } catch (error) {
    if (error instanceof ContentValidationError)
      throw badRequest(error.message, "VALIDATION_ERROR");
    throw error;
  }
}

async function loadRecords(db: Db, ids: readonly string[]): Promise<ContentRecord[]> {
  if (!ids.length) return [];
  const rows = await db.query<{ data: string }>(
    "SELECT data FROM records WHERE deleted = 0 AND id = ANY($1::text[])",
    [ids],
  );
  return rows.flatMap((row) => parseJson<ContentRecord>(row.data) ?? []);
}

/** Cross-record checks of a batch against the database. Must run inside the write transaction. */
async function validateBatch(db: Db, records: ContentRecord[]): Promise<void> {
  const ids = records.map((record) => record.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id))
      throw badRequest(`ID ${id} повторяется в загружаемом файле`, "VALIDATION_ERROR");
    seen.add(id);
  }

  const existingKinds = await db.query<{ id: string; kind: string }>(
    "SELECT id, kind FROM records WHERE id = ANY($1::text[])",
    [ids],
  );
  const incomingKind = new Map(records.map((record) => [record.id, record.kind]));
  for (const row of existingKinds) {
    if (row.kind !== incomingKind.get(row.id))
      throw conflict(`ID ${row.id} уже занят материалом другого типа`, "KIND_CONFLICT");
  }

  const linked = linkedRecordIds(records).filter((id) => !seen.has(id));
  const known = new Map((await loadRecords(db, linked)).map((record) => [record.id, record]));
  try {
    validateLinks(records, known);
  } catch (error) {
    if (error instanceof ContentValidationError)
      throw badRequest(error.message, "VALIDATION_ERROR");
    throw error;
  }

  const olympiads = records.filter((record): record is Olympiad => record.kind === "olympiads");
  if (olympiads.length) {
    const rows = await db.query<{ data: string }>(
      "SELECT data FROM records WHERE deleted = 0 AND kind = 'olympiads'",
    );
    const existing = rows.flatMap((row) => parseJson<Olympiad>(row.data) ?? []);
    const duplicate = findDuplicateOlympiad(olympiads, existing);
    if (duplicate)
      throw conflict(
        `Олимпиада «${duplicate.record.title}» уже есть в календаре (${duplicate.duplicateOf.id}): ` +
          "совпадают название, регион и дата",
        "DUPLICATE_OLYMPIAD",
      );
  }
}

async function snapshot(db: Db, recordId: string, now: number): Promise<void> {
  await db.execute(
    "INSERT INTO revisions(id, record_id, data, created) SELECT $1, id, data, $2 FROM records WHERE id = $3",
    [crypto.randomUUID(), now, recordId],
  );
}

/**
 * Saves a draft. For a published record only the `draft` column changes (children keep seeing the
 * published version); a new or deleted record becomes an unpublished draft.
 */
export async function saveDraft(ctx: ServiceContext, input: unknown): Promise<number> {
  const record = prepareIncoming(input);
  await ctx.db.transaction(async (tx) => {
    await validateBatch(tx, [record]);
    const current = await tx.one<{ deleted: number }>(
      "SELECT deleted FROM records WHERE id = $1 FOR UPDATE",
      [record.id],
    );
    const draft = JSON.stringify(record);
    if (current && Number(current.deleted) === 0) {
      await tx.execute(
        "UPDATE records SET draft = $2, updated = GREATEST($3, updated + 1) WHERE id = $1",
        [record.id, draft, ctx.now],
      );
    } else {
      await tx.execute(
        `INSERT INTO records(id, kind, data, draft, updated, deleted) VALUES($1, $2, $3, $4, $5, 0)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data,
           draft = excluded.draft, updated = ${RAISE_UPDATED}, deleted = 0`,
        [record.id, record.kind, JSON.stringify({ ...record, unpublished: true }), draft, ctx.now],
      );
    }
  });
  return 1;
}

/** Publishes records atomically (one record from the editor or a bulk import). */
export async function publishRecords(ctx: ServiceContext, inputs: unknown): Promise<number> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_IMPORT_RECORDS)
    throw badRequest(
      `Загрузите массив от 1 до ${MAX_IMPORT_RECORDS} материалов`,
      "VALIDATION_ERROR",
    );
  const records = inputs.map(prepareIncoming);
  await ctx.db.transaction(async (tx) => {
    await validateBatch(tx, records);
    for (const record of records) {
      await snapshot(tx, record.id, ctx.now);
      await tx.execute(
        `INSERT INTO records(id, kind, data, draft, updated, deleted) VALUES($1, $2, $3, NULL, $4, 0)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, draft = NULL,
           updated = ${RAISE_UPDATED}, deleted = 0`,
        [record.id, record.kind, JSON.stringify(record), ctx.now],
      );
    }
  });
  return records.length;
}

interface RevisionRow {
  id: string;
  record_id: string;
  data: string;
  created: number;
}

export async function recordHistory(ctx: ServiceContext, recordId: string): Promise<Revision[]> {
  const rows = await ctx.db.query<RevisionRow>(
    "SELECT id, record_id, data, created FROM revisions WHERE record_id = $1 ORDER BY created DESC, id",
    [recordId],
  );
  return rows.map((row) => ({
    id: row.id,
    record_id: row.record_id,
    data: parseJson<ContentRecord>(row.data) as ContentRecord,
    created: Number(row.created),
  }));
}

/**
 * Restores a revision as a draft. A deleted record comes back as an unpublished draft, so an old
 * version never becomes visible to children without an explicit publish.
 */
export async function restoreRevision(ctx: ServiceContext, revisionId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const revision = await tx.one<RevisionRow>(
      "SELECT id, record_id, data, created FROM revisions WHERE id = $1",
      [revisionId],
    );
    if (!revision) throw notFound("Версия не найдена", "REVISION_NOT_FOUND");
    const data = parseJson<ContentRecord>(revision.data) as ContentRecord;
    const { unpublished: _unpublished, ...clean } = data;
    const current = await tx.one<{ deleted: number }>(
      "SELECT deleted FROM records WHERE id = $1 FOR UPDATE",
      [revision.record_id],
    );
    if (current && Number(current.deleted) === 0) {
      await tx.execute(
        "UPDATE records SET draft = $2, updated = GREATEST($3, updated + 1) WHERE id = $1",
        [revision.record_id, JSON.stringify(clean), ctx.now],
      );
      return;
    }
    await tx.execute(
      `INSERT INTO records(id, kind, data, draft, updated, deleted) VALUES($1, $2, $3, $4, $5, 0)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, draft = excluded.draft,
         updated = ${RAISE_UPDATED}, deleted = 0`,
      [
        revision.record_id,
        data.kind,
        JSON.stringify({ ...clean, unpublished: true }),
        JSON.stringify(clean),
        ctx.now,
      ],
    );
  });
}

/** Soft delete: the record disappears for everyone, a revision keeps its last version. */
export async function deleteRecord(ctx: ServiceContext, recordId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const current = await tx.one<{ id: string }>(
      "SELECT id FROM records WHERE id = $1 AND deleted = 0 FOR UPDATE",
      [recordId],
    );
    if (!current) throw notFound("Материал не найден", "RECORD_NOT_FOUND");
    await snapshot(tx, recordId, ctx.now);
    await tx.execute(
      "UPDATE records SET deleted = 1, updated = GREATEST($2, updated + 1) WHERE id = $1",
      [recordId, ctx.now],
    );
  });
}

export async function listDeleted(ctx: ServiceContext): Promise<ContentRecord[]> {
  const rows = await ctx.db.query<{ data: string }>(
    "SELECT data FROM records WHERE deleted = 1 ORDER BY updated DESC, id",
  );
  return rows.flatMap((row) => parseJson<ContentRecord>(row.data) ?? []);
}
