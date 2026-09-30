import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/olympus/route";
import type { BootstrapResponse } from "@/lib/domain/types";
import {
  cleanupSessions,
  EMPTY_GUEST_SESSION_TTL_MS,
  GUEST_SESSION_TTL_MS,
  parseSeedMode,
  readSeedBundle,
  seedDatabase,
  sha256,
} from "../../scripts/seed.mjs";
import { migrate } from "../../scripts/postgres-migrate.mjs";
import { bootstrap, configureEnv, resetDatabase, sql, withClient } from "../support/server";

const topic = (id: string, title = "Тема") => ({
  id,
  kind: "topics",
  title,
  grade: 4,
  subject: "math",
});

beforeEach(() => resetDatabase({ seed: false }));

describe("seed modes", () => {
  it("bootstrap fills an empty database once and records hashes", async () => {
    const records = [topic("t1"), topic("t2")];
    const first = await withClient((client) =>
      seedDatabase(client, { mode: "bootstrap", records }),
    );
    expect(first).toEqual({ mode: "bootstrap", action: "bootstrapped", changed: 2 });
    const rows = await sql<{ id: string; data: string; deleted: number }>(
      "SELECT id, data, deleted FROM records ORDER BY id",
    );
    expect(rows.map((row) => row.id)).toEqual(["t1", "t2"]);
    const imports = await sql<{ id: string; hash: string }>(
      "SELECT id, hash FROM imports ORDER BY id",
    );
    expect(imports).toEqual([
      { id: "bundle", hash: sha256(JSON.stringify(records)) },
      { id: "t1", hash: sha256(JSON.stringify(records[0])) },
      { id: "t2", hash: sha256(JSON.stringify(records[1])) },
    ]);
    const again = await withClient((client) =>
      seedDatabase(client, { mode: "bootstrap", records: [topic("t3")] }),
    );
    expect(again.action).toBe("skipped");
    expect(await sql("SELECT 1 FROM records WHERE id = 't3'")).toHaveLength(0);
  });

  it("bootstrap never overwrites a database that already has content", async () => {
    await sql(
      "INSERT INTO records(id, kind, data, updated, deleted) VALUES('admin-made', 'topics', '{}', 1, 0)",
    );
    const result = await withClient((client) =>
      seedDatabase(client, { mode: "bootstrap", records: [topic("t1")] }),
    );
    expect(result).toEqual({ mode: "bootstrap", action: "marked", changed: 0 });
    expect(await sql("SELECT id FROM records")).toEqual([{ id: "admin-made" }]);
    expect(await sql("SELECT id FROM imports")).toEqual([{ id: "bundle" }]);
  });

  it("sync upserts only changed records and keeps revisions of the old version", async () => {
    await withClient((client) =>
      seedDatabase(client, { mode: "bootstrap", records: [topic("t1"), topic("t2")], now: 1000 }),
    );
    await sql("UPDATE records SET deleted = 1, draft = '{}' WHERE id = 't2'");
    const unchanged = await withClient((client) =>
      seedDatabase(client, { mode: "sync", records: [topic("t1"), topic("t2")] }),
    );
    expect(unchanged.action).toBe("up-to-date");

    const next = [topic("t1"), topic("t2", "Новое имя"), topic("t3")];
    const result = await withClient((client) =>
      seedDatabase(client, { mode: "sync", records: next, now: 2000 }),
    );
    expect(result).toEqual({ mode: "sync", action: "synced", changed: 2 });
    const t2 = await sql<{ data: string; deleted: number; draft: string | null; updated: string }>(
      "SELECT data, deleted, draft, updated FROM records WHERE id = 't2'",
    );
    expect(JSON.parse(t2[0].data).title).toBe("Новое имя");
    expect(t2[0]).toMatchObject({ deleted: 0, draft: null });
    const revisions = await sql<{ record_id: string; data: string }>(
      "SELECT record_id, data FROM revisions",
    );
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0].data).title).toBe("Тема");
    expect(await sql("SELECT 1 FROM records WHERE id = 't3'")).toHaveLength(1);
    // t1 was not touched.
    const t1 = await sql<{ updated: string }>("SELECT updated FROM records WHERE id = 't1'");
    expect(Number(t1[0].updated)).toBe(1000);
  });

  it("off does nothing", async () => {
    const result = await withClient((client) =>
      seedDatabase(client, { mode: "off", records: [topic("t1")] }),
    );
    expect(result.action).toBe("skipped");
    expect(await sql("SELECT 1 FROM records")).toHaveLength(0);
  });

  it("serialises concurrent seeders with the advisory lock", async () => {
    const records = readSeedBundle();
    const results = await Promise.all([
      withClient((client) => seedDatabase(client, { mode: "bootstrap", records })),
      withClient((client) => seedDatabase(client, { mode: "bootstrap", records })),
    ]);
    expect(results.map((result) => result.action).sort()).toEqual(["bootstrapped", "skipped"]);
    const [{ count }] = await sql<{ count: string }>("SELECT COUNT(*) FROM records");
    expect(Number(count)).toBe(records.length);
  });

  it("rolls back a failed seed completely", async () => {
    const broken = [
      topic("t1"),
      { id: "t2", kind: null } as unknown as { id: string; kind: string },
    ];
    await expect(
      withClient((client) => seedDatabase(client, { mode: "bootstrap", records: broken })),
    ).rejects.toThrow();
    expect(await sql("SELECT 1 FROM records")).toHaveLength(0);
    expect(await sql("SELECT 1 FROM imports")).toHaveLength(0);
  });

  it("parses SEED_MODE", () => {
    expect(parseSeedMode(undefined)).toBe("bootstrap");
    expect(parseSeedMode(" Sync ")).toBe("sync");
    expect(parseSeedMode("off")).toBe("off");
    expect(() => parseSeedMode("always")).toThrow(/SEED_MODE/);
  });

  it("the real bundle matches the hash format of the previous in-app seeding", () => {
    const records = readSeedBundle();
    expect(sha256(JSON.stringify(records))).toMatch(/^[0-9a-f]{64}$/);
    expect(records.length).toBeGreaterThan(700);
  });
});

describe("session cleanup", () => {
  it("removes expired sessions and legacy photos only", async () => {
    const now = Date.now();
    await sql(
      `INSERT INTO sessions(token, user_id, name, photo, admin, expires) VALUES
        ('expired', 'guest:1', NULL, NULL, 0, $1),
        ('alive', 'max:2', 'Имя', 'https://photo', 0, $2)`,
      [now - 1, now + 60_000],
    );
    expect(await withClient((client) => cleanupSessions(client, now))).toBe(1);
    expect(await sql("SELECT token, photo FROM sessions")).toEqual([
      { token: "alive", photo: null },
    ]);
  });

  it("removes guest sessions that saved nothing for a day, keeps the others", async () => {
    const now = Date.now();
    const createdAt = (ago: number) => now - ago + GUEST_SESSION_TTL_MS;
    const day = EMPTY_GUEST_SESSION_TTL_MS;
    await sql(
      `INSERT INTO sessions(token, user_id, admin, expires) VALUES
        ('empty-old', 'guest:empty-old', 0, $1),
        ('empty-new', 'guest:empty-new', 0, $2),
        ('busy-old', 'guest:busy-old', 0, $1),
        ('admin-old', 'guest:admin-old', 1, $1),
        ('max-old', 'max:1', 0, $3)`,
      [createdAt(day + 1000), createdAt(day - 60_000), now + 1000],
    );
    await sql(
      "INSERT INTO progress(user_id, key, data, updated) VALUES('guest:busy-old', 'settings', '{}', 1)",
    );
    expect(await withClient((client) => cleanupSessions(client, now))).toBe(1);
    expect(
      (await sql<{ token: string }>("SELECT token FROM sessions ORDER BY token")).map(
        (r) => r.token,
      ),
    ).toEqual(["admin-old", "busy-old", "empty-new", "max-old"]);
  });
});

describe("migrations", () => {
  it("are idempotent and additive", async () => {
    const applied = await withClient((client) => migrate(client, { log: () => undefined }));
    expect(applied).toEqual([]);
    const columns = await sql<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions' ORDER BY column_name",
    );
    expect(columns.map((column) => column.column_name)).toContain("admin_seen");
  });

  it("hash the tokens of existing sessions, which keep working", async () => {
    configureEnv();
    const legacy = "c".repeat(64);
    const earlier = fs.mkdtempSync(path.join(os.tmpdir(), "olympus-migrations-"));
    for (const file of ["0000_postgres_init.sql", "0001_backend_hardening.sql"])
      fs.copyFileSync(path.join("drizzle", file), path.join(earlier, file));
    await withClient(async (client) => {
      await client.query(
        "DROP TABLE IF EXISTS records, revisions, sessions, progress, imports, _olympus_migrations CASCADE",
      );
      await migrate(client, { dir: earlier, log: () => undefined });
      await client.query(
        "INSERT INTO sessions(token, user_id, admin, expires) VALUES($1, 'guest:legacy', 0, $2)",
        [legacy, Date.now() + 60_000],
      );
      await client.query(
        "INSERT INTO progress(user_id, key, data, updated) VALUES('guest:legacy', 'settings', '{\"grade\":5}', 1)",
      );
      const applied = await migrate(client, { log: () => undefined });
      expect(applied).toContain("0003_session_token_hash.sql");
    });
    expect(await sql("SELECT 1 FROM sessions WHERE token = $1", [legacy])).toHaveLength(0);
    const response = await bootstrap<BootstrapResponse>(GET, { token: legacy });
    expect(response.body.sessionToken).toBe(legacy);
    expect(response.body.progress.settings).toEqual({ grade: 5 });
  });
});
