// Applies drizzle/*.sql in name order, each file once, inside a transaction.
import fs from "node:fs";
import path from "node:path";
import { connect, isMain } from "./lib/pg.mjs";

/**
 * @param {import("pg").Client} client
 * @param {{ dir?: string; log?: (message: string) => void }} [options]
 * @returns {Promise<string[]>} names of the applied migrations
 */
export async function migrate(client, options = {}) {
  const { dir = path.resolve("drizzle"), log = console.log } = options;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  await client.query(`
    CREATE TABLE IF NOT EXISTS _olympus_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = new Set(
    (await client.query("SELECT name FROM _olympus_migrations")).rows.map((row) => row.name),
  );
  const done = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    log(`[db] applying ${file}`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO _olympus_migrations(name) VALUES($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    done.push(file);
  }
  log("[db] PostgreSQL migrations are up to date");
  return done;
}

if (isMain(import.meta.url)) {
  const client = await connect();
  try {
    await migrate(client);
  } finally {
    await client.end();
  }
}
