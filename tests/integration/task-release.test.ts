import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ContentRecord, Task } from "@/lib/domain/types";
import { migrate } from "../../scripts/postgres-migrate.mjs";
import { readSeedBundle, seedDatabase, sha256 } from "../../scripts/seed.mjs";
import { sql, withClient } from "../support/server";

const release = "0004_task_replacements_20261026.sql";
const next = readSeedBundle() as ContentRecord[];
const before = JSON.parse(
  fs.readFileSync("tests/fixtures/tasks.before-2026-10-26.json", "utf8"),
) as Task[];
const oldById = new Map(before.map((task) => [task.id, task]));
const newById = new Map(next.map((record) => [record.id, record]));
const previous = next.map((record) => oldById.get(record.id) ?? record);
const ids = before.map((task) => task.id);
let baselineDir: string;

async function snapshot() {
  return {
    records: await sql("SELECT * FROM records ORDER BY id"),
    imports: await sql("SELECT * FROM imports ORDER BY id"),
    sessions: await sql("SELECT * FROM sessions ORDER BY token"),
    progress: await sql("SELECT * FROM progress ORDER BY user_id, key"),
  };
}

beforeAll(() => {
  baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "olympus-release-baseline-"));
  for (const file of fs
    .readdirSync("drizzle")
    .filter((file) => file.endsWith(".sql") && file < release))
    fs.copyFileSync(path.join("drizzle", file), path.join(baselineDir, file));
});

afterAll(() => {
  if (path.dirname(baselineDir) !== os.tmpdir()) throw new Error("Unexpected temporary directory");
  fs.rmSync(baselineDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await withClient(async (client) => {
    await client.query(
      "DROP TABLE IF EXISTS records, revisions, sessions, progress, imports, _olympus_migrations CASCADE",
    );
    await migrate(client, { dir: baselineDir, log: () => undefined });
    await seedDatabase(client, { mode: "bootstrap", records: previous });
  });
});

describe("one-time task rollout to an existing PostgreSQL database", () => {
  it("updates exactly ten tasks under bootstrap while preserving drafts, unrelated data and progress", async () => {
    const draft = JSON.stringify({ ...before[0], title: "Черновик учителя" });
    await sql("UPDATE records SET draft = $1 WHERE id = $2", [draft, ids[0]]);
    await sql("UPDATE records SET data = $1 WHERE id = $2", [
      JSON.stringify({ ...newById.get("math-4-01-task-1"), title: "Правка учителя вне релиза" }),
      "math-4-01-task-1",
    ]);
    await sql(
      "INSERT INTO progress(user_id, key, data, updated) VALUES('guest:release', $1, $2, 123)",
      [`task:${ids[0]}`, JSON.stringify({ correct: true, attempts: 4 })],
    );
    await sql(
      "INSERT INTO sessions(token, user_id, name, expires) VALUES('hashed-token', 'guest:release', 'Ученик', 9999999999999)",
    );
    const original = await snapshot();
    await withClient(async (client) => {
      expect(await migrate(client, { log: () => undefined })).toEqual([release]);
      expect(await seedDatabase(client, { mode: "bootstrap", records: next })).toMatchObject({
        action: "skipped",
        changed: 0,
      });
    });
    const result = await snapshot();
    expect(result.sessions).toEqual(original.sessions);
    expect(result.progress).toEqual(original.progress);
    expect(result.records.filter((row) => !ids.includes(row.id as string))).toEqual(
      original.records.filter((row) => !ids.includes(row.id as string)),
    );
    expect(result.imports.filter((row) => !ids.includes(row.id as string))).toEqual(
      original.imports.filter((row) => !ids.includes(row.id as string)),
    );
    for (const id of ids) {
      const record = result.records.find((row) => row.id === id)!;
      expect(JSON.parse(record.data as string)).toEqual(newById.get(id));
      expect(result.imports.find((row) => row.id === id)?.hash).toBe(
        sha256(JSON.stringify(newById.get(id))),
      );
    }
    expect(result.records.find((row) => row.id === ids[0])?.draft).toBe(draft);
    const revisions = await sql("SELECT record_id, data FROM revisions ORDER BY record_id");
    expect(revisions).toHaveLength(10);
    for (const row of revisions)
      expect(JSON.parse(row.data as string)).toEqual(oldById.get(row.record_id as string));
  });

  it("does not overwrite later teacher edits or add revisions when the release is restarted", async () => {
    await withClient((client) => migrate(client, { log: () => undefined }));
    await sql("UPDATE records SET data = $1 WHERE id = $2", [
      JSON.stringify({ ...newById.get(ids[0]), title: "После выпуска учитель изменил задачу" }),
      ids[0],
    ]);
    const original = await snapshot();
    await withClient(async (client) => {
      expect(await migrate(client, { log: () => undefined })).toEqual([]);
      await seedDatabase(client, { mode: "bootstrap", records: next });
    });
    expect(await snapshot()).toEqual(original);
    expect(await sql("SELECT id FROM revisions")).toHaveLength(10);
  });

  it("preserves soft deletions, skips already current tasks and creates missing tasks with a live topic", async () => {
    await sql("UPDATE records SET deleted = 1, draft = 'kept' WHERE id = $1", [ids[0]]);
    await sql("DELETE FROM records WHERE id = $1", [ids[1]]);
    await sql("UPDATE records SET data = $1 WHERE id = $2", [
      JSON.stringify(newById.get(ids[2])),
      ids[2],
    ]);
    const deleted = await sql("SELECT * FROM records WHERE id = $1", [ids[0]]);
    const oldHash = await sql("SELECT hash FROM imports WHERE id = $1", [ids[0]]);
    await withClient((client) => migrate(client, { log: () => undefined }));
    expect(await sql("SELECT * FROM records WHERE id = $1", [ids[0]])).toEqual(deleted);
    expect(await sql("SELECT hash FROM imports WHERE id = $1", [ids[0]])).toEqual(oldHash);
    expect(
      JSON.parse(
        (await sql<{ data: string }>("SELECT data FROM records WHERE id = $1", [ids[1]]))[0].data,
      ),
    ).toEqual(newById.get(ids[1]));
    expect(await sql("SELECT id FROM revisions")).toHaveLength(7);
  });

  it("rolls back content, revisions, hashes and the migration marker if a write fails", async () => {
    const original = await snapshot();
    await withClient(async (client) => {
      await client.query(`CREATE FUNCTION pg_temp.reject_task_release() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated release failure'; END; $$`);
      await client.query(
        "CREATE TRIGGER reject_task_release BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_task_release()",
      );
      await expect(migrate(client, { log: () => undefined })).rejects.toThrow(
        "simulated release failure",
      );
      await client.query("DROP TRIGGER reject_task_release ON records");
    });
    expect(await snapshot()).toEqual(original);
    expect(await sql("SELECT id FROM revisions")).toHaveLength(0);
    expect(
      await sql("SELECT name FROM _olympus_migrations WHERE name = $1", [release]),
    ).toHaveLength(0);
    await withClient((client) => migrate(client, { log: () => undefined }));
    expect(await sql("SELECT id FROM revisions")).toHaveLength(10);
  });

  it("leaves a fresh database ready for ordinary bootstrap of the complete new bundle", async () => {
    await withClient(async (client) => {
      await client.query(
        "DROP TABLE records, revisions, sessions, progress, imports, _olympus_migrations CASCADE",
      );
      await migrate(client, { log: () => undefined });
      expect(await seedDatabase(client, { mode: "bootstrap", records: next })).toMatchObject({
        action: "bootstrapped",
        changed: next.length,
      });
    });
    expect(await sql("SELECT id FROM records")).toHaveLength(next.length);
    expect(await sql("SELECT id FROM revisions")).toHaveLength(0);
  });
});
