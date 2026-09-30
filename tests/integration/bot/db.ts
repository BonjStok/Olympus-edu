/**
 * Test database helpers for the bot suites. The schema is created by the real
 * migration script (drizzle/0000 + drizzle/0002 in this branch), and every test
 * starts from empty app and bot tables.
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";

export const databaseUrl = () => String(process.env.TEST_DATABASE_URL);

export function migrate() {
  const result = spawnSync("node", ["scripts/postgres-migrate.mjs"], {
    env: { ...process.env, DATABASE_URL: databaseUrl() },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Migration failed: ${result.stderr || result.stdout}`);
}

export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export function reset() {
  return withDb((db) =>
    db.query("TRUNCATE records, progress, sessions, bot_reminders, bot_users CASCADE"),
  );
}

export function insertRecords(records: { id: string; kind: string; [k: string]: unknown }[]) {
  return withDb(async (db) => {
    for (const r of records)
      await db.query(
        "INSERT INTO records (id, kind, data, updated, deleted) VALUES ($1, $2, $3, $4, 0)",
        [r.id, r.kind, JSON.stringify(r), Date.now()],
      );
  });
}

export function insertProgress(maxUserId: string | number, values: Record<string, unknown>) {
  return withDb(async (db) => {
    for (const [key, data] of Object.entries(values))
      await db.query("INSERT INTO progress (user_id, key, data, updated) VALUES ($1, $2, $3, $4)", [
        `max:${maxUserId}`,
        key,
        JSON.stringify(data),
        Date.now(),
      ]);
  });
}

export function query<Row = Record<string, unknown>>(sql: string, values: unknown[] = []) {
  return withDb(async (db) => (await db.query<Row>(sql, values)).rows);
}
