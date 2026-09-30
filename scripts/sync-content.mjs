// Applies content changes from the compiled seed (lib/seed.json) to an EXISTING database – the safe
// way to roll out a new calendar or rewritten lessons/tasks to production without touching user
// progress. Dry run by default: it only prints what would change.
//
//   node scripts/sync-content.mjs [--kinds olympiads,tasks] [--deletions ids.json] [--apply]
//
// Inside the production container (the deletions file is read from stdin with "-"):
//   docker compose exec -T web node scripts/sync-content.mjs --kinds olympiads --deletions - < ids.json
//
// Rules:
//   - records of the selected kinds that are new are created, changed ones are updated; the previous
//     version of every updated or deleted record is saved to `revisions` (admins can restore it);
//   - pending admin drafts are kept; records soft-deleted by an admin stay deleted unless
//     --restore-deleted is given; records that exist only in the database are left as they are;
//   - --deletions soft-deletes the listed ids (JSON: ["id", ...], [{ "id", "reason" }, ...] or
//     { "ids": [...] });
//   - the result is validated as a whole before anything is written: record schema, links between
//     records (topics, tasks of mock tests), references to deleted records, duplicate olympiads;
//   - everything is written in one transaction under the seeding advisory lock; running the same
//     sync again changes nothing.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { regions } from "../lib/content/regions.mjs";
import {
  ContentValidationError,
  ID_PATTERN,
  RECORD_KINDS,
  findDuplicateOlympiad,
  linkedRecordIds,
  validateLinks,
  validateRecord,
} from "../lib/content/validate.mjs";
import { connect, isMain } from "./lib/pg.mjs";
import { SEED_ADVISORY_LOCK, sha256 } from "./seed.mjs";

/** @typedef {import("../lib/domain/types").ContentRecord} ContentRecord */
/** @typedef {import("../lib/domain/types").RecordKind} RecordKind */
/** @typedef {{ id: string; reason?: string }} Deletion */
/**
 * @typedef {object} SyncOptions
 * @property {unknown} records seed records (validated again here)
 * @property {readonly RecordKind[]} [kinds] kinds to sync; all kinds by default
 * @property {Deletion[]} [deletions] ids to soft-delete
 * @property {boolean} [apply] write the changes (default: dry run)
 * @property {boolean} [restoreDeleted] bring back records that were soft-deleted in the database
 * @property {number} [now]
 */
/**
 * @typedef {object} KindCounts
 * @property {number} create
 * @property {number} update
 * @property {number} unchanged
 * @property {number} restore
 * @property {number} skippedDeleted records deleted in the database (see --restore-deleted)
 * @property {number} delete
 * @property {number} extra records that exist only in the database (left as they are)
 */
/**
 * @typedef {object} SyncSummary
 * @property {boolean} applied
 * @property {RecordKind[]} kinds
 * @property {number} seedRecords seed records of the selected kinds
 * @property {Record<string, KindCounts>} byKind
 * @property {string[]} created
 * @property {string[]} updated
 * @property {string[]} restored
 * @property {string[]} skippedDeleted
 * @property {string[]} deleted
 * @property {string[]} alreadyDeleted deletion ids that are already soft-deleted
 * @property {string[]} notFound deletion ids that do not exist in the database
 * @property {string[]} otherKind deletion ids of kinds that were not selected (left as they are)
 * @property {string[]} draftsKept updated records that still have a pending admin draft
 * @property {string[]} dbOnly records of the selected kinds that exist only in the database
 * @property {number} revisions revisions written (0 in a dry run)
 */

export class SyncError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SyncError";
  }
}

/**
 * JSON with object keys sorted at every level: records written by the admin panel and by the seed
 * may list the same fields in a different order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * @param {string | undefined} value comma-separated kinds
 * @returns {RecordKind[]}
 */
export function parseKinds(value) {
  if (value === undefined) return [...RECORD_KINDS];
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const unknown = kinds.filter((kind) => !RECORD_KINDS.includes(/** @type {RecordKind} */ (kind)));
  if (!kinds.length || unknown.length)
    throw new SyncError(
      `--kinds: unknown kind ${unknown.join(", ") || "(empty)"}; use ${RECORD_KINDS.join(", ")}`,
    );
  return /** @type {RecordKind[]} */ ([...new Set(kinds)]);
}

/**
 * Parses a deletions file: `["id", ...]`, `[{ "id": "...", "reason": "..." }, ...]` or
 * `{ "ids": [...] }`.
 * @param {string} text
 * @returns {Deletion[]}
 */
export function parseDeletions(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SyncError(
      `deletions: invalid JSON (${error instanceof Error ? error.message : error})`,
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) value = value.ids;
  if (!Array.isArray(value))
    throw new SyncError('deletions: expected ["id", ...], [{ "id": ... }] or { "ids": [...] }');
  /** @type {Map<string, Deletion>} */
  const byId = new Map();
  for (const item of value) {
    const entry =
      typeof item === "string"
        ? { id: item }
        : item && typeof item === "object" && typeof item.id === "string"
          ? {
              id: item.id,
              ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
            }
          : null;
    if (!entry || !ID_PATTERN.test(entry.id))
      throw new SyncError(`deletions: invalid id ${JSON.stringify(item)}`);
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * Validates the seed records (same rules as the build and the admin panel). Also returns the hash
 * of every record in the format of scripts/seed.mjs (`imports` table).
 * @param {unknown} input
 * @returns {{ records: ContentRecord[]; hashes: Map<string, string> }}
 */
function validateSeed(input) {
  if (!Array.isArray(input)) throw new SyncError("seed: expected an array of records");
  /** @type {ContentRecord[]} */
  const records = [];
  /** @type {Map<string, string>} */
  const hashes = new Map();
  for (const item of input) {
    let record;
    try {
      record = validateRecord(item, { regions });
    } catch (error) {
      if (error instanceof ContentValidationError) throw new SyncError(`seed: ${error.message}`);
      throw error;
    }
    if (hashes.has(record.id)) throw new SyncError(`seed: duplicate id ${record.id}`);
    hashes.set(record.id, sha256(JSON.stringify(item)));
    records.push(record);
  }
  return { records, hashes };
}

/**
 * @typedef {{ id: string; kind: string; data: string; draft: string | null; deleted: number }} RecordRow
 */

/** @returns {KindCounts} */
const emptyCounts = () => ({
  create: 0,
  update: 0,
  unchanged: 0,
  restore: 0,
  skippedDeleted: 0,
  delete: 0,
  extra: 0,
});

/**
 * Computes the changes and checks the resulting content. Pure: `rows` is the current `records`
 * table.
 * @param {RecordRow[]} rows
 * @param {ContentRecord[]} seed validated seed records (all kinds)
 * @param {{ kinds: readonly RecordKind[]; deletions: Deletion[]; restoreDeleted: boolean }} options
 */
export function planSync(rows, seed, options) {
  const kinds = new Set(options.kinds);
  const selected = seed.filter((record) => kinds.has(record.kind));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const seedIds = new Set(selected.map((record) => record.id));
  /** @type {Record<string, KindCounts>} */
  const byKind = Object.fromEntries(options.kinds.map((kind) => [kind, emptyCounts()]));
  /** @type {Omit<SyncSummary, "applied" | "kinds" | "seedRecords" | "byKind" | "revisions">} */
  const lists = {
    created: [],
    updated: [],
    restored: [],
    skippedDeleted: [],
    deleted: [],
    alreadyDeleted: [],
    notFound: [],
    otherKind: [],
    draftsKept: [],
    dbOnly: [],
  };
  /** @type {ContentRecord[]} */
  const writes = [];

  for (const record of selected) {
    const row = rowsById.get(record.id);
    const counts = byKind[record.kind];
    if (!row) {
      counts.create += 1;
      lists.created.push(record.id);
      writes.push(record);
      continue;
    }
    if (row.kind !== record.kind)
      throw new SyncError(
        `${record.id}: the database has a record of kind ${row.kind}, the seed has ${record.kind}`,
      );
    if (Number(row.deleted) === 1) {
      if (!options.restoreDeleted) {
        counts.skippedDeleted += 1;
        lists.skippedDeleted.push(record.id);
        continue;
      }
      counts.restore += 1;
      lists.restored.push(record.id);
      writes.push(record);
      continue;
    }
    if (canonicalJson(JSON.parse(row.data)) === canonicalJson(record)) {
      counts.unchanged += 1;
      continue;
    }
    counts.update += 1;
    lists.updated.push(record.id);
    if (row.draft !== null) lists.draftsKept.push(record.id);
    writes.push(record);
  }

  /** @type {Set<string>} */
  const extra = new Set();
  for (const row of rows) {
    const live = Number(row.deleted) === 0;
    if (live && kinds.has(/** @type {RecordKind} */ (row.kind)) && !seedIds.has(row.id))
      extra.add(row.id);
  }

  /** @type {string[]} */
  const deletes = [];
  for (const { id } of options.deletions) {
    if (seedIds.has(id))
      throw new SyncError(
        `${id}: listed for deletion but present in the seed – remove one of them`,
      );
    const row = rowsById.get(id);
    if (!row) lists.notFound.push(id);
    else if (!kinds.has(/** @type {RecordKind} */ (row.kind))) lists.otherKind.push(id);
    else if (Number(row.deleted) === 1) lists.alreadyDeleted.push(id);
    else {
      deletes.push(id);
      lists.deleted.push(id);
      extra.delete(id);
      byKind[row.kind].delete += 1;
    }
  }
  for (const id of extra) {
    byKind[/** @type {RecordRow} */ (rowsById.get(id)).kind].extra += 1;
    lists.dbOnly.push(id);
  }

  checkResult(rows, writes, new Set(deletes));
  return { byKind, lists, writes, deletes, seedRecords: selected.length };
}

/**
 * Checks the content as it will be after the sync: links of written records, records that would
 * point to a deleted one, and duplicate olympiads.
 * @param {RecordRow[]} rows
 * @param {ContentRecord[]} writes
 * @param {Set<string>} deletes
 */
function checkResult(rows, writes, deletes) {
  const written = new Set(writes.map((record) => record.id));
  /** @type {Map<string, ContentRecord>} */
  const kept = new Map();
  for (const row of rows) {
    if (Number(row.deleted) === 1 || deletes.has(row.id) || written.has(row.id)) continue;
    kept.set(row.id, /** @type {ContentRecord} */ (JSON.parse(row.data)));
  }

  try {
    validateLinks(writes, kept);
  } catch (error) {
    if (error instanceof ContentValidationError) throw new SyncError(error.message);
    throw error;
  }

  const survivors = [...kept.values(), ...writes];
  const dangling = survivors.flatMap((record) =>
    linkedRecordIds([record])
      .filter((id) => deletes.has(id))
      .map((id) => `${record.id} → ${id}`),
  );
  if (dangling.length)
    throw new SyncError(
      `records would point to deleted records: ${dangling.join(", ")} – update or delete them too`,
    );

  const olympiads = /** @type {import("../lib/domain/types").Olympiad[]} */ (
    writes.filter((record) => record.kind === "olympiads")
  );
  const duplicate = findDuplicateOlympiad(
    olympiads,
    /** @type {import("../lib/domain/types").Olympiad[]} */ (
      [...kept.values()].filter((record) => record.kind === "olympiads")
    ),
  );
  if (duplicate)
    throw new SyncError(
      `duplicate olympiad: ${duplicate.record.id} repeats ${duplicate.duplicateOf.id} ` +
        "(same title, region and date) – add the old id to --deletions or fix the seed",
    );
}

/**
 * @param {import("pg").Client} client
 * @param {string} id
 * @param {number} now
 */
async function saveRevision(client, id, now) {
  await client.query(
    "INSERT INTO revisions(id, record_id, data, created) SELECT $1, id, data, $2 FROM records WHERE id = $3",
    [randomUUID(), now, id],
  );
}

/**
 * Plans and (with `apply`) writes the sync in one transaction. A dry run rolls back and writes
 * nothing.
 * @param {import("pg").Client} client
 * @param {SyncOptions} options
 * @returns {Promise<SyncSummary>}
 */
export async function syncContent(client, options) {
  const {
    kinds = [...RECORD_KINDS],
    deletions = [],
    apply = false,
    restoreDeleted = false,
    now = Date.now(),
  } = options;
  const { records: seed, hashes } = validateSeed(options.records);

  await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    if (apply) await client.query("SELECT pg_advisory_xact_lock($1)", [SEED_ADVISORY_LOCK]);
    /** @type {RecordRow[]} */
    const rows = (
      await client.query(
        `SELECT id, kind, data, draft, deleted FROM records ORDER BY id${apply ? " FOR UPDATE" : ""}`,
      )
    ).rows;
    const plan = planSync(rows, seed, { kinds, deletions, restoreDeleted });

    let revisions = 0;
    if (apply) {
      const existing = new Set(rows.map((row) => row.id));
      for (const record of plan.writes) {
        const data = JSON.stringify(record);
        if (existing.has(record.id)) {
          await saveRevision(client, record.id, now);
          revisions += 1;
        }
        // The draft column is kept: a pending admin draft is not lost. `updated` always grows, so
        // the web's catalogue cache sees the change (lib/services/catalogue.ts).
        await client.query(
          `INSERT INTO records(id, kind, data, draft, updated, deleted) VALUES($1, $2, $3, NULL, $4, 0)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data,
             updated = GREATEST(excluded.updated, records.updated + 1), deleted = 0`,
          [record.id, record.kind, data, now],
        );
      }
      for (const id of plan.deletes) {
        await saveRevision(client, id, now);
        revisions += 1;
        await client.query(
          "UPDATE records SET deleted = 1, updated = GREATEST($2, updated + 1) WHERE id = $1",
          [id, now],
        );
      }
      // Remember what was imported, so that SEED_MODE=sync at the next start agrees with it.
      const skipped = new Set(plan.lists.skippedDeleted);
      for (const record of seed) {
        if (!kinds.includes(record.kind) || skipped.has(record.id)) continue;
        await client.query(
          "INSERT INTO imports(id, hash) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash",
          [record.id, hashes.get(record.id) ?? ""],
        );
      }
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return {
      applied: apply,
      kinds: [...kinds],
      seedRecords: plan.seedRecords,
      byKind: plan.byKind,
      ...plan.lists,
      revisions,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * @param {string} title
 * @param {string[]} ids
 * @param {boolean} verbose
 */
function idList(title, ids, verbose) {
  if (!ids.length) return [];
  const shown = verbose ? ids : ids.slice(0, 20);
  const more = ids.length - shown.length;
  return [
    `${title} (${ids.length}): ${shown.join(", ")}${more ? ` … and ${more} more (--verbose)` : ""}`,
  ];
}

/**
 * Human-readable report of a sync.
 * @param {SyncSummary} summary
 * @param {{ seedFile?: string; deletionsFile?: string; verbose?: boolean }} [context]
 */
export function formatSummary(summary, context = {}) {
  const verbose = Boolean(context.verbose);
  const lines = [
    summary.applied
      ? "Content sync: APPLIED"
      : "Content sync: DRY RUN – nothing was written (add --apply to write)",
    `Seed: ${context.seedFile ?? "lib/seed.json"}, ${summary.seedRecords} records of kinds ${summary.kinds.join(", ")}`,
  ];
  if (context.deletionsFile) lines.push(`Deletions: ${context.deletionsFile}`);
  const columns = /** @type {const} */ ([
    ["create", "create"],
    ["update", "update"],
    ["unchanged", "same"],
    ["restore", "restore"],
    ["skippedDeleted", "skipped"],
    ["delete", "delete"],
    ["extra", "db-only"],
  ]);
  const pad = (/** @type {string | number} */ value, width = 9) => String(value).padStart(width);
  lines.push("", `${"kind".padEnd(12)}${columns.map(([, label]) => pad(label)).join("")}`);
  for (const [kind, counts] of Object.entries(summary.byKind))
    lines.push(`${kind.padEnd(12)}${columns.map(([key]) => pad(counts[key])).join("")}`);
  lines.push("");
  lines.push(
    ...idList("Created", summary.created, verbose),
    ...idList("Updated (previous version kept in revisions)", summary.updated, verbose),
    ...idList("Restored from deleted", summary.restored, verbose),
    ...idList("Deleted (soft, revision kept)", summary.deleted, verbose),
    ...idList(
      "Skipped: deleted in the database (use --restore-deleted to bring back)",
      summary.skippedDeleted,
      verbose,
    ),
    ...idList("Deletion ids already deleted", summary.alreadyDeleted, verbose),
    ...idList("Deletion ids not found in the database", summary.notFound, verbose),
    ...idList("Deletion ids of kinds not selected (left as is)", summary.otherKind, verbose),
    ...idList(
      "Updated records with a pending admin draft (draft kept)",
      summary.draftsKept,
      verbose,
    ),
    ...idList(
      "Only in the database, left as is (add to --deletions to remove)",
      summary.dbOnly,
      verbose,
    ),
  );
  const changes =
    summary.created.length +
    summary.updated.length +
    summary.restored.length +
    summary.deleted.length;
  lines.push(
    summary.applied
      ? `Done: ${changes} records changed, ${summary.revisions} revisions saved.`
      : changes
        ? `${changes} records would change. Review the list, then run again with --apply.`
        : "Nothing to change: the database already matches the seed.",
  );
  return lines.join("\n");
}

export const USAGE = `Usage: node scripts/sync-content.mjs [options]

Applies the compiled seed (pnpm compile-content → lib/seed.json) to an existing database.
Dry run unless --apply is given.

Options:
  --apply                  write the changes (one transaction)
  --kinds <list>           comma-separated: ${RECORD_KINDS.join(", ")} (default: all)
  --deletions <file|->     JSON with ids to soft-delete ("-" reads stdin)
  --seed <file>            seed bundle (default: lib/seed.json)
  --restore-deleted        also bring back records that were deleted in the database
  --verbose                list every id
  --json                   print the summary as JSON
  -h, --help               show this help

Database: DATABASE_URL or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME (as the app).`;

/**
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        apply: { type: "boolean", default: false },
        kinds: { type: "string" },
        deletions: { type: "string" },
        seed: { type: "string", default: "lib/seed.json" },
        "restore-deleted": { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new SyncError(error instanceof Error ? error.message : String(error));
  }
  const values = parsed.values;
  return {
    apply: Boolean(values.apply),
    kinds: parseKinds(values.kinds),
    deletionsFile: values.deletions,
    seedFile: String(values.seed),
    restoreDeleted: Boolean(values["restore-deleted"]),
    verbose: Boolean(values.verbose),
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

/**
 * @param {string} file path or "-" for stdin
 * @param {string} what
 */
function readText(file, what) {
  try {
    return file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  } catch (error) {
    const hint = what === "seed" ? " (run pnpm compile-content first)" : "";
    throw new SyncError(
      `cannot read the ${what} file ${file}${hint}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * @param {string} text
 * @param {string} file
 */
function parseSeedText(text, file) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyncError(
      `${file}: invalid JSON (${error instanceof Error ? error.message : error})`,
    );
  }
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const records = parseSeedText(readText(args.seedFile, "seed"), args.seedFile);
  const deletions = args.deletionsFile
    ? parseDeletions(readText(args.deletionsFile, "deletions"))
    : [];
  const client = await connect(process.env, { attempts: 3 });
  try {
    const summary = await syncContent(client, {
      records,
      kinds: args.kinds,
      deletions,
      apply: args.apply,
      restoreDeleted: args.restoreDeleted,
    });
    console.log(
      args.json
        ? JSON.stringify(summary, null, 2)
        : formatSummary(summary, {
            seedFile: args.seedFile,
            deletionsFile: args.deletionsFile === "-" ? "stdin" : args.deletionsFile,
            verbose: args.verbose,
          }),
    );
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sync-content] failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
