// scripts/sync-content.mjs against a real PostgreSQL: the production calendar rollout (snapshot of
// production on 2026-09-29 → verified calendar of 501 olympiads + 28 deletions), transactions,
// revisions, the advisory lock and the command line.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import type { BootstrapResponse, ContentRecord } from "@/lib/domain/types";
import { readSeedBundle, SEED_ADVISORY_LOCK, seedDatabase } from "../../scripts/seed.mjs";
import { parseDeletions, syncContent } from "../../scripts/sync-content.mjs";
import {
  adminToken,
  bootstrap,
  configureEnv,
  guestToken,
  resetDatabase,
  rpc,
  sql,
  withClient,
} from "../support/server";

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

type Json = { id: string } & Record<string, unknown>;
const production = readJson<Json[]>("tests/fixtures/olympiads.production-2026-09-29.json");
const verified = readJson<Json[]>("tests/fixtures/olympiads.cleaned.json").map((record) => ({
  ...record,
  kind: "olympiads",
}));
const deletions = parseDeletions(
  fs.readFileSync("tests/fixtures/olympiads.delete-ids.json", "utf8"),
);
/** Lessons, tasks, topics and mocks of the current bundle (whatever the content is today). */
const learning = (readSeedBundle() as unknown as ContentRecord[]).filter(
  (record) => record.kind !== "olympiads",
);
/** The next seed: the current learning content plus the verified calendar. */
const nextSeed = [...verified, ...learning];
/** Published by an admin in production and absent from every bundle: sync must not touch it. */
const adminMade = {
  id: "admin-made-olympiad",
  kind: "olympiads",
  title: "Олимпиада, которую добавил администратор",
  subject: "math",
  grades: [5],
  format: "online",
  region: "",
  url: "https://example.org/admin-made",
  deadline: "expected",
  date: "expected",
};

async function count(where: string): Promise<number> {
  const [row] = await sql<{ count: string }>(
    `SELECT COUNT(*) AS count FROM records WHERE ${where}`,
  );
  return Number(row.count);
}

describe("rollout of the verified calendar to a production-like database", () => {
  let child: string;
  const updatedId = "moscow-math-festival-2027";
  const deletedId = deletions[0].id;

  beforeAll(async () => {
    await resetDatabase({ seed: false });
    configureEnv();
    // Production state: the learning content seeded at start-up plus the 521 olympiads published
    // through the admin panel (and one more that exists only in the database).
    await withClient(async (client) => {
      await seedDatabase(client, { mode: "bootstrap", records: learning });
      for (const record of [
        ...production.map((item) => ({ ...item, kind: "olympiads" })),
        adminMade,
      ])
        await client.query(
          "INSERT INTO records(id, kind, data, draft, updated, deleted) VALUES($1, 'olympiads', $2, NULL, 1, 0)",
          [record.id, JSON.stringify(record)],
        );
    });
    child = await guestToken(POST);
    for (const id of [updatedId, deletedId])
      expect((await rpc(POST, "register", { id, yes: true }, { token: child })).status).toBe(200);
  });

  it("dry run lists the changes and writes nothing", async () => {
    const before = await sql("SELECT id, data, deleted FROM records ORDER BY id");
    const summary = await withClient((client) =>
      syncContent(client, { records: nextSeed, kinds: ["olympiads"], deletions }),
    );
    expect(summary).toMatchObject({ applied: false, seedRecords: verified.length, revisions: 0 });
    expect(summary.byKind.olympiads).toEqual({
      create: 8,
      update: 493,
      unchanged: 0,
      restore: 0,
      skippedDeleted: 0,
      delete: 28,
      // Records that exist only in the database are left as they are.
      extra: 1,
    });
    expect(summary.updated).toContain(updatedId);
    expect(summary.deleted).toContain(deletedId);
    expect(summary.notFound).toEqual([]);
    expect(await sql("SELECT id, data, deleted FROM records ORDER BY id")).toEqual(before);
    expect(await sql("SELECT 1 FROM revisions")).toHaveLength(0);
  });

  it("applies in one go: calendar replaced, revisions kept, children's progress untouched", async () => {
    const summary = await withClient((client) =>
      syncContent(client, { records: nextSeed, kinds: ["olympiads"], deletions, apply: true }),
    );
    expect(summary).toMatchObject({ applied: true, revisions: 493 + 28 });
    expect(await count("kind = 'olympiads' AND deleted = 0")).toBe(verified.length + 1);
    expect(await count("kind = 'olympiads' AND deleted = 1")).toBe(28);
    // Other kinds were not selected and stay as they were.
    expect(await count("kind <> 'olympiads'")).toBe(learning.length);

    const view = await bootstrap<BootstrapResponse>(GET, { token: child });
    const ids = new Set(view.body.records.map((record) => record.id));
    for (const record of verified) expect(ids.has(record.id)).toBe(true);
    expect(ids.has(adminMade.id)).toBe(true);
    expect(ids.has(deletedId)).toBe(false);
    // Progress is never touched by a content sync.
    expect(view.body.progress[`registration:${updatedId}`]).toEqual({ registered: true });
    expect(view.body.progress[`registration:${deletedId}`]).toEqual({ registered: true });
    const gone = await rpc(POST, "register", { id: deletedId, yes: true }, { token: child });
    expect(gone.status).toBe(404);

    // Admins find the previous version in the history and can restore it.
    const admin = await adminToken(POST);
    const history = await rpc<{ history: { data: ContentRecord }[] }>(
      POST,
      "history",
      { id: updatedId },
      { token: admin },
    );
    const previous = production.find((record) => record.id === updatedId);
    expect(history.body.history[0].data).toEqual({ ...previous, kind: "olympiads" });
  });

  it("is idempotent, and SEED_MODE=sync agrees with it afterwards", async () => {
    const again = await withClient((client) =>
      syncContent(client, { records: nextSeed, kinds: ["olympiads"], deletions, apply: true }),
    );
    expect(again.byKind.olympiads).toMatchObject({
      create: 0,
      update: 0,
      unchanged: verified.length,
    });
    expect(again).toMatchObject({ created: [], updated: [], deleted: [], revisions: 0 });
    expect(again.alreadyDeleted).toHaveLength(28);

    const seeded = await withClient((client) =>
      seedDatabase(client, { mode: "sync", records: nextSeed }),
    );
    expect(seeded).toMatchObject({ action: "synced", changed: 0 });
  });
});

describe("sync rules on the database", () => {
  const topic = (id: string, title = "Тема") => ({
    id,
    kind: "topics",
    title,
    grade: 4,
    subject: "math",
    order: 1,
  });

  beforeEach(async () => {
    await resetDatabase({ seed: false });
    await withClient((client) =>
      seedDatabase(client, { mode: "bootstrap", records: [topic("t1"), topic("t2")], now: 1000 }),
    );
  });

  it("keeps pending drafts and admin deletions unless asked to restore", async () => {
    await sql("UPDATE records SET draft = $1 WHERE id = 't1'", [
      JSON.stringify(topic("t1", "Черновик")),
    ]);
    await sql("UPDATE records SET deleted = 1 WHERE id = 't2'");
    const records = [topic("t1", "Новая"), topic("t2", "Новая")];
    const summary = await withClient((client) =>
      syncContent(client, { records, apply: true, now: 2000 }),
    );
    expect(summary).toMatchObject({ updated: ["t1"], draftsKept: ["t1"], skippedDeleted: ["t2"] });
    const rows = await sql<{ id: string; data: string; draft: string | null; deleted: number }>(
      "SELECT id, data, draft, deleted FROM records ORDER BY id",
    );
    expect(JSON.parse(rows[0].data).title).toBe("Новая");
    expect(JSON.parse(rows[0].draft as string).title).toBe("Черновик");
    expect(rows[1]).toMatchObject({ deleted: 1 });
    expect(JSON.parse(rows[1].data).title).toBe("Тема");

    const restored = await withClient((client) =>
      syncContent(client, { records, apply: true, restoreDeleted: true, now: 3000 }),
    );
    expect(restored).toMatchObject({ restored: ["t2"], revisions: 1 });
    expect(await count("id = 't2' AND deleted = 0")).toBe(1);
    const revisions = await sql<{ record_id: string }>(
      "SELECT record_id FROM revisions ORDER BY created",
    );
    expect(revisions.map((row) => row.record_id)).toEqual(["t1", "t2"]);
  });

  it("writes nothing when the result would be inconsistent", async () => {
    const task = {
      id: "k1",
      kind: "tasks",
      title: "Задача",
      topicId: "missing-topic",
      type: "number",
      prompt: "?",
      answer: "1",
      solution: "1",
    };
    await expect(
      withClient((client) =>
        syncContent(client, { records: [topic("t1", "Новая"), task], apply: true }),
      ),
    ).rejects.toThrow(/тема missing-topic не найдена/);
    await expect(
      withClient((client) => syncContent(client, { records: [{ id: "bad" }], apply: true })),
    ).rejects.toThrow(/seed: .*Неизвестный тип материала/);
    expect(
      JSON.parse((await sql<{ data: string }>("SELECT data FROM records WHERE id = 't1'"))[0].data)
        .title,
    ).toBe("Тема");
    expect(await sql("SELECT 1 FROM revisions")).toHaveLength(0);
  });

  it("waits for a running seeder (advisory lock)", async () => {
    await withClient(async (holder) => {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [SEED_ADVISORY_LOCK]);
      let finished = false;
      const sync = withClient((client) =>
        syncContent(client, { records: [topic("t1", "Новая")], apply: true }),
      ).then((summary) => {
        finished = true;
        return summary;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      await holder.query("COMMIT");
      expect((await sync).updated).toEqual(["t1"]);
    });
  });
});

describe("command line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olympus-sync-"));
  const seedFile = path.join(dir, "seed.json");

  beforeAll(async () => {
    await resetDatabase({ seed: false });
    const records = [
      { id: "t1", kind: "topics", title: "Тема", grade: 4, subject: "math" },
      { id: "t2", kind: "topics", title: "Лишняя", grade: 4, subject: "math" },
    ];
    await withClient((client) => seedDatabase(client, { mode: "bootstrap", records }));
    fs.writeFileSync(
      seedFile,
      JSON.stringify([{ id: "t1", kind: "topics", title: "Новая", grade: 4, subject: "math" }]),
    );
  });

  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["scripts/sync-content.mjs", ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    });

  it("prints a dry run, reads deletions from stdin and applies with --apply", async () => {
    const dry = run(["--seed", seedFile, "--deletions", "-"], '["t2"]');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("DRY RUN");
    expect(dry.stdout).toMatch(/topics\s+0\s+1\s+0\s+0\s+0\s+1\s+0/);
    expect(dry.stdout).toContain("Deletions: stdin");
    expect(await count("deleted = 1")).toBe(0);

    const applied = run(["--seed", seedFile, "--deletions", "-", "--apply", "--json"], '["t2"]');
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      applied: true,
      updated: ["t1"],
      deleted: ["t2"],
      revisions: 2,
    });
    expect(await count("deleted = 1")).toBe(1);
  });

  it("explains wrong arguments and missing files", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--deletions <file|->");
    const wrong = run(["--kinds", "users"]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain("unknown kind users");
    const missing = run(["--seed", path.join(dir, "nope.json")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("run pnpm compile-content first");
    const conflict = run(["--seed", seedFile, "--deletions", "-"], '["t1"]');
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("listed for deletion but present in the seed");
  });
});
