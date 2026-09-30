// Loads the compiled content bundle (lib/seed.json) into PostgreSQL and removes expired sessions.
// Runs once at container start after the migrations (scripts/docker-start.mjs) and via
// `pnpm db:setup` locally – never on the request path.
//
// SEED_MODE:
//   bootstrap (default) – import the bundle only into an empty database; a database that already
//                         has records is just marked as bootstrapped (admin edits are safe);
//   sync                – upsert records whose content changed since the last import (a revision of
//                         the previous version is kept, so admins can restore it);
//   off                 – do nothing.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { connect, isMain } from "./lib/pg.mjs";

/** Serialises concurrent starts (several containers) on the same database. */
export const SEED_ADVISORY_LOCK = 721849311;
export const SEED_MODES = ["bootstrap", "sync", "off"];

/** @param {string} text */
export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * @param {string | undefined} value
 * @returns {"bootstrap" | "sync" | "off"}
 */
export function parseSeedMode(value) {
  const mode = String(value || "bootstrap")
    .trim()
    .toLowerCase();
  if (!SEED_MODES.includes(mode)) throw new Error("SEED_MODE must be bootstrap, sync or off");
  return /** @type {"bootstrap" | "sync" | "off"} */ (mode);
}

/**
 * @typedef {{ id: string; kind: string }} SeedRecord
 * @typedef {{ mode: string; action: "skipped" | "marked" | "bootstrapped" | "synced" | "up-to-date"; changed: number }} SeedResult
 */

/**
 * @param {import("pg").Client} client
 * @param {string} id
 * @param {string} hash
 */
async function rememberHash(client, id, hash) {
  await client.query(
    "INSERT INTO imports(id, hash) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash",
    [id, hash],
  );
}

/**
 * Seeds inside one transaction guarded by an advisory lock.
 * @param {import("pg").Client} client
 * @param {{ mode: "bootstrap" | "sync" | "off"; records: SeedRecord[]; now?: number }} options
 * @returns {Promise<SeedResult>}
 */
export async function seedDatabase(client, options) {
  const { mode, records, now = Date.now() } = options;
  if (mode === "off") return { mode, action: "skipped", changed: 0 };

  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SEED_ADVISORY_LOCK]);
    const result = await seedLocked(client, mode, records, now);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * @param {import("pg").Client} client
 * @param {"bootstrap" | "sync"} mode
 * @param {SeedRecord[]} records
 * @param {number} now
 * @returns {Promise<SeedResult>}
 */
async function seedLocked(client, mode, records, now) {
  // Same hashing as the previous in-app seeding, so existing `imports` rows stay valid.
  const bundleHash = sha256(JSON.stringify(records));
  const bundle = (await client.query("SELECT hash FROM imports WHERE id = 'bundle'")).rows[0];

  if (mode === "bootstrap") {
    if (bundle?.hash) return { mode, action: "skipped", changed: 0 };
    const count = Number(
      (await client.query("SELECT COUNT(*) AS count FROM records")).rows[0].count,
    );
    if (count > 0) {
      await rememberHash(client, "bundle", bundleHash);
      return { mode, action: "marked", changed: 0 };
    }
  } else if (bundle?.hash === bundleHash) {
    return { mode, action: "up-to-date", changed: 0 };
  }

  const known = new Map(
    (await client.query("SELECT id, hash FROM imports WHERE id <> 'bundle'")).rows.map((row) => [
      row.id,
      row.hash,
    ]),
  );
  let changed = 0;
  for (const record of records) {
    const data = JSON.stringify(record);
    const hash = sha256(data);
    if (mode === "sync" && known.get(record.id) === hash) continue;
    if (mode === "sync")
      await client.query(
        "INSERT INTO revisions(id, record_id, data, created) SELECT $1, id, data, $2 FROM records WHERE id = $3",
        [randomUUID(), now, record.id],
      );
    // `updated` always grows, so the web's catalogue cache sees the change
    // (lib/services/catalogue.ts).
    await client.query(
      `INSERT INTO records(id, kind, data, draft, updated, deleted) VALUES($1, $2, $3, NULL, $4, 0)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, draft = NULL,
         updated = GREATEST(excluded.updated, records.updated + 1), deleted = 0`,
      [record.id, record.kind, data, now],
    );
    await rememberHash(client, record.id, hash);
    changed += 1;
  }
  await rememberHash(client, "bundle", bundleHash);
  return { mode, action: mode === "sync" ? "synced" : "bootstrapped", changed };
}

/** Same as GUEST_SESSION_TTL_MS in lib/server/session.ts (a unit test keeps them equal). */
export const GUEST_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Guest sessions without any progress are removed after this time. */
export const EMPTY_GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Removes expired sessions, guest sessions that were created more than a day ago and never saved
 * anything (every visit without a token starts a guest session, so crawlers and one-off visits
 * would otherwise pile up for a year), and legacy profile photos (photos are not stored any more).
 * @param {import("pg").Client} client
 * @param {number} [now]
 * @returns {Promise<number>} removed sessions
 */
export async function cleanupSessions(client, now = Date.now()) {
  const expired = await client.query("DELETE FROM sessions WHERE expires <= $1", [now]);
  // A guest session is created with expires = created + GUEST_SESSION_TTL_MS.
  const empty = await client.query(
    `DELETE FROM sessions s
      WHERE s.user_id LIKE 'guest:%' AND s.admin = 0 AND s.expires < $1
        AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.user_id = s.user_id)`,
    [now + GUEST_SESSION_TTL_MS - EMPTY_GUEST_SESSION_TTL_MS],
  );
  await client.query("UPDATE sessions SET photo = NULL WHERE photo IS NOT NULL AND photo <> ''");
  return (expired.rowCount ?? 0) + (empty.rowCount ?? 0);
}

/** @param {string} [file] */
export function readSeedBundle(file = "lib/seed.json") {
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(records)) throw new Error(`${file} must contain an array of records`);
  return /** @type {SeedRecord[]} */ (records);
}

async function main() {
  const cleanupOnly = process.argv.includes("--cleanup-only");
  const mode = parseSeedMode(process.env.SEED_MODE);
  const client = await connect();
  try {
    if (!cleanupOnly) {
      const result = await seedDatabase(client, {
        mode,
        records: mode === "off" ? [] : readSeedBundle(),
      });
      console.log(`[seed] mode=${result.mode} ${result.action} (${result.changed} records)`);
    }
    const removed = await cleanupSessions(client);
    console.log(`[seed] removed ${removed} expired sessions`);
  } finally {
    await client.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error("[seed] failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
