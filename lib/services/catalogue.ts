// Children's catalogue of `GET /api/olympus`, cached per worker isolate as a ready JSON string.
//
// Every app open used to read all `records` rows, parse each one, project the summaries and
// serialise ~700 KB of JSON. The published content changes only when a teacher or a script writes
// it, so each request now asks PostgreSQL for a cheap content version first (one aggregate query
// over `records`, no JSON columns) and reuses the serialised catalogue while the version is the
// same.
//
// Invariant that makes the version exact: every write to `records` (admin draft/publish/import/
// delete/restore, scripts/seed.mjs, scripts/sync-content.mjs) either inserts a row, flips
// `deleted`, or raises the row's `updated` strictly (`GREATEST(now, updated + 1)`). So `live`,
// `gone` or `sum(updated)` changes with every committed write and never returns to an old value.
//
// Only strings live in module memory: no connections, promises or other I/O objects, which workerd
// binds to the request that created them.
import type { Db } from "@/lib/server/db";
import { listCatalogue } from "./content";

/** One aggregate over `records` (no JSON columns are read). */
export const CONTENT_VERSION_SQL = `SELECT count(*) FILTER (WHERE deleted = 0) AS live,
       count(*) FILTER (WHERE deleted = 1) AS gone,
       max(updated) AS updated,
       sum(updated) AS total
  FROM records`;

interface VersionRow {
  live: number | string;
  gone: number | string;
  updated: number | string | null;
  total: number | string | null;
}

interface CachedCatalogue {
  version: string;
  /** `JSON.stringify` of the published summaries. */
  json: string;
}

let cached: CachedCatalogue | null = null;

/** Opaque version of the published content: changes with every write to `records`. */
export async function contentVersion(db: Db): Promise<string> {
  const row = await db.one<VersionRow>(CONTENT_VERSION_SQL);
  return [row?.live ?? 0, row?.gone ?? 0, row?.updated ?? 0, row?.total ?? 0].join(":");
}

/**
 * The children's catalogue (`records` of the bootstrap) as a JSON array string.
 *
 * The version is read before the rows: if a write lands in between, the cached rows are newer than
 * their version and the next request simply rebuilds; the opposite order could keep stale rows.
 */
export async function catalogueJson(db: Db): Promise<string> {
  const version = await contentVersion(db);
  if (cached && cached.version === version) return cached.json;
  const json = JSON.stringify(await listCatalogue(db));
  cached = { version, json };
  return json;
}

/** Forgets the cached catalogue (tests; the next request rebuilds it). */
export function resetCatalogueCache(): void {
  cached = null;
}
