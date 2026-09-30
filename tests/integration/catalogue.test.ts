// Children's catalogue of `GET /api/olympus` against PostgreSQL: slim olympiads, the per-isolate
// cache and its invalidation by every content write path, the `olympiad` action, and the
// unchanged `GET /api/v1/content`.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { GET as content } from "@/app/api/v1/content/route";
import type {
  AdminRecord,
  BootstrapResponse,
  ContentRecord,
  Olympiad,
  RecordSummary,
  Revision,
  Topic,
} from "@/lib/domain/types";
import { Database, withDatabase } from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";
import { API_SECURITY_HEADERS } from "@/lib/server/http";
import { publishRecords } from "@/lib/services/admin";
import { CONTENT_VERSION_SQL, resetCatalogueCache } from "@/lib/services/catalogue";
import { olympiadSummary } from "@/lib/services/content";
import { readSeedBundle, seedDatabase } from "../../scripts/seed.mjs";
import { syncContent } from "../../scripts/sync-content.mjs";
import { FIXTURE_RECORDS } from "../support/fixtures";
import {
  adminToken,
  bootstrap,
  configureEnv,
  guestToken,
  ORIGIN,
  resetDatabase,
  rpc,
  sql,
  TEST_API_PASSWORD,
  toApiResponse,
  withClient,
} from "../support/server";

const bundle = readSeedBundle() as unknown as ContentRecord[];
const seedOlympiad = (id: string) =>
  bundle.find((record): record is Olympiad => record.id === id && record.kind === "olympiads")!;
/** A published olympiad of the real calendar with every optional field the calendar uses. */
const NTO = seedOlympiad("nto-junior-robotech-2026");
const DETAIL_FIELDS = ["description", "source", "verifiedAt", "image"] as const;

const olympiad = (id: string, overrides: Partial<Olympiad> = {}): Olympiad => ({
  kind: "olympiads",
  id,
  title: `Олимпиада ${id}`,
  subject: "math",
  grades: [5],
  format: "online",
  region: "",
  url: "https://example.org/register",
  deadline: "2026-11-01",
  date: "2026-11-10",
  description: `Описание ${id}`,
  source: "https://example.org/rules",
  verifiedAt: "2026-09-01",
  ...overrides,
});

/** Counts the queries of the app's request-scoped connections. */
function watchQueries() {
  const spy = vi.spyOn(Database.prototype, "query");
  const texts = () => spy.mock.calls.map(([text]) => text);
  return {
    /** Full reads of the `records` rows (the catalogue build). */
    rowReads: () =>
      texts().filter((text) =>
        text.startsWith("SELECT id, kind, data, draft, deleted FROM records"),
      ).length,
    versionReads: () => texts().filter((text) => text === CONTENT_VERSION_SQL).length,
    clear: () => spy.mockClear(),
  };
}

let admin: string;
let child: string;
let queries: ReturnType<typeof watchQueries>;

async function childBootstrap(token = child) {
  return bootstrap<BootstrapResponse>(GET, { token });
}

/** The child's catalogue and whether this request rebuilt it from the rows. */
async function childCatalogue(): Promise<{ records: RecordSummary[]; rebuilt: boolean }> {
  queries.clear();
  const response = await childBootstrap();
  expect(response.status).toBe(200);
  expect(queries.versionReads()).toBe(1);
  return { records: response.body.records as RecordSummary[], rebuilt: queries.rowReads() === 1 };
}

/** Fills the cache and checks that it is used. */
async function warm(): Promise<void> {
  await childCatalogue();
  expect((await childCatalogue()).rebuilt).toBe(false);
}

const find = (records: RecordSummary[], id: string) => records.find((record) => record.id === id);

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  configureEnv();
  admin = await adminToken(POST);
  child = await guestToken(POST);
});
beforeEach(() => {
  configureEnv();
  queries = watchQueries();
});
afterEach(() => vi.restoreAllMocks());

describe("children's catalogue", () => {
  it("lists olympiads without the details-screen fields", async () => {
    const response = await childBootstrap();
    const olympiads = response.body.records.filter((record) => record.kind === "olympiads");
    expect(olympiads.length).toBe(
      [...bundle, ...FIXTURE_RECORDS].filter((r) => r.kind === "olympiads" && !r.unpublished)
        .length,
    );
    for (const record of olympiads)
      for (const field of DETAIL_FIELDS) expect(record).not.toHaveProperty(field);
    expect(find(response.body.records as RecordSummary[], NTO.id)).toEqual({
      id: "nto-junior-robotech-2026",
      kind: "olympiads",
      title: NTO.title,
      subject: "info",
      grades: [5, 6],
      format: "online",
      region: "",
      stage: "Отборочный этап",
      registrationType: "link",
      url: "https://my.ntcontest.ru/",
      registrationStart: "2026-08-26",
      deadline: "expected",
      date: "2026-10-20",
      dateEnd: "2026-11-10",
      price: 0,
      featured: false,
    });
  });

  it("keeps complete records with drafts for the teacher", async () => {
    const response = await bootstrap<BootstrapResponse>(GET, { token: admin });
    const record = (response.body.records as AdminRecord[]).find((r) => r.id === NTO.id);
    expect(record).toEqual({ ...NTO, draft: null });
  });

  it("leaves GET /api/v1/content exactly as it was: complete olympiads", async () => {
    const auth = await toApiResponse<{ accessToken: string }>(
      await login(
        new Request(`${ORIGIN}/api/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "test_user", password: TEST_API_PASSWORD }),
        }),
      ),
    );
    const token = auth.body.accessToken;
    const v1 = await toApiResponse<{ records: ContentRecord[]; count: number }>(
      await content(
        new Request(`${ORIGIN}/api/v1/content`, { headers: { authorization: `Bearer ${token}` } }),
      ),
    );
    expect(v1.status).toBe(200);
    const entry = v1.body.records.find((record) => record.id === NTO.id);
    expect(entry).toEqual(NTO);
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "date",
      "dateEnd",
      "deadline",
      "description",
      "featured",
      "format",
      "grades",
      "id",
      "image",
      "kind",
      "price",
      "region",
      "registrationStart",
      "registrationType",
      "source",
      "stage",
      "subject",
      "title",
      "url",
      "verifiedAt",
    ]);
    // Same records in the same order as the mini-app; only olympiads differ (complete in v1).
    const app = (await childBootstrap()).body.records as RecordSummary[];
    expect(v1.body.count).toBe(app.length);
    expect(v1.body.records.map((record) => record.id)).toEqual(app.map((record) => record.id));
    v1.body.records.forEach((record, index) =>
      expect(app[index]).toEqual(record.kind === "olympiads" ? olympiadSummary(record) : record),
    );
  });
});

describe("cache", () => {
  it("serves the second bootstrap without reading the rows, per-user parts stay fresh", async () => {
    resetCatalogueCache();
    queries.clear();
    const first = await childBootstrap();
    expect(queries.rowReads()).toBe(1);

    queries.clear();
    const second = await childBootstrap();
    expect(queries.rowReads()).toBe(0);
    expect(queries.versionReads()).toBe(1);
    expect(second.body.records).toEqual(first.body.records);
    expect(second.body.serverTime).toBeGreaterThanOrEqual(first.body.serverTime);

    // Another child shares the catalogue but gets their own progress and session.
    await rpc(POST, "register", { id: NTO.id, yes: true }, { token: child });
    const other = await guestToken(POST);
    queries.clear();
    const theirs = await childBootstrap(other);
    const mine = await childBootstrap();
    expect(queries.rowReads()).toBe(0);
    expect(theirs.body.sessionToken).toBe(other);
    expect(theirs.body.progress).toEqual({});
    expect(mine.body.progress[`registration:${NTO.id}`]).toEqual({ registered: true });

    // The teacher's catalogue is never served from it.
    queries.clear();
    await bootstrap<BootstrapResponse>(GET, { token: admin });
    expect(queries.rowReads()).toBe(1);
    expect(queries.versionReads()).toBe(0);
  });

  it("answers with the same headers from the cache", async () => {
    await warm();
    const response = await childBootstrap();
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
      expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(Math.abs(Date.parse(response.headers.get("date") ?? "") - Date.now())).toBeLessThan(
      5_000,
    );
    // A new guest still gets the cookie.
    const guest = await bootstrap<BootstrapResponse>(GET);
    expect(guest.headers.get("set-cookie")).toContain(guest.body.sessionToken);
  });
});

describe("every content write invalidates the cache", () => {
  it("publish: new and changed records", async () => {
    await warm();
    await rpc(POST, "publish", { record: olympiad("cache-a") }, { token: admin });
    let next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-a")).toMatchObject({ title: "Олимпиада cache-a" });

    await warm();
    await rpc(
      POST,
      "publish",
      { record: olympiad("cache-a", { title: "Новое название" }) },
      { token: admin },
    );
    next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-a")).toMatchObject({ title: "Новое название" });
  });

  it("draft save: of a published record and of a new one", async () => {
    await warm();
    const before = (await childCatalogue()).records;
    await rpc(
      POST,
      "draft",
      { record: olympiad("cache-a", { title: "Черновик" }) },
      { token: admin },
    );
    let next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    // Children keep seeing the published version.
    expect(find(next.records, "cache-a")).toEqual(find(before, "cache-a"));

    await warm();
    await rpc(POST, "draft", { record: olympiad("cache-draft") }, { token: admin });
    next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-draft")).toBeUndefined();
  });

  it("import", async () => {
    await warm();
    const response = await rpc(
      POST,
      "import",
      { records: [olympiad("cache-b"), olympiad("cache-c")] },
      { token: admin },
    );
    expect(response.body).toEqual({ ok: true, count: 2 });
    const next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-b")).toBeDefined();
    expect(find(next.records, "cache-c")).toBeDefined();
  });

  it("delete, then restore (of the deleted record and of a live one)", async () => {
    await warm();
    expect((await rpc(POST, "delete", { id: "cache-b" }, { token: admin })).status).toBe(200);
    let next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-b")).toBeUndefined();

    const history = async (id: string) =>
      (await rpc<{ history: Revision[] }>(POST, "history", { id }, { token: admin })).body.history;
    await warm();
    const [deletedVersion] = await history("cache-b");
    await rpc(POST, "restore", { revisionId: deletedVersion.id }, { token: admin });
    next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    // Restored as an unpublished draft: still hidden from children.
    expect(find(next.records, "cache-b")).toBeUndefined();

    await warm();
    const [liveVersion] = await history("cache-a");
    await rpc(POST, "restore", { revisionId: liveVersion.id }, { token: admin });
    next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
  });

  it("writes in the same millisecond or with a clock behind the stored one", async () => {
    const env = getEnv();
    const publishAt = (now: number, title: string) =>
      withDatabase(env, (db) =>
        publishRecords({ db, env, actor: { userId: "admin:test", admin: true }, now }, [
          olympiad("cache-c", { title }),
        ]),
      );
    const [{ updated }] = await sql<{ updated: number }>(
      "SELECT updated FROM records WHERE id = 'cache-c'",
    );

    await warm();
    await publishAt(Number(updated), "Та же миллисекунда");
    let next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-c")).toMatchObject({ title: "Та же миллисекунда" });

    await warm();
    await publishAt(Number(updated) - 60_000, "Часы отстают");
    next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, "cache-c")).toMatchObject({ title: "Часы отстают" });
    const [after] = await sql<{ updated: number }>(
      "SELECT updated FROM records WHERE id = 'cache-c'",
    );
    expect(Number(after.updated)).toBe(Number(updated) + 2);
  });

  it("SEED_MODE=sync", async () => {
    const topic = bundle.find((record): record is Topic => record.kind === "topics")!;
    const renamed: Topic = { ...topic, title: "Тема из новой сборки" };
    await warm();
    const result = await withClient((client) =>
      seedDatabase(client, { mode: "sync", records: [renamed] }),
    );
    expect(result.changed).toBe(1);
    const next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, topic.id)).toMatchObject({ title: "Тема из новой сборки" });
  });

  it("scripts/sync-content: update and deletion", async () => {
    await warm();
    const summary = await withClient((client) =>
      syncContent(client, {
        records: [{ ...NTO, title: "НТО Юниоры (обновлено)" }],
        kinds: ["olympiads"],
        deletions: [{ id: "cache-a" }],
        apply: true,
      }),
    );
    expect(summary).toMatchObject({ updated: [NTO.id], deleted: ["cache-a"] });
    const next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(find(next.records, NTO.id)).toMatchObject({ title: "НТО Юниоры (обновлено)" });
    expect(find(next.records, "cache-a")).toBeUndefined();
  });

  it("SEED_MODE=bootstrap into an empty database", async () => {
    await resetDatabase({ seed: false });
    child = await guestToken(POST);
    await warm();
    expect((await childCatalogue()).records).toEqual([]);
    const records = bundle.filter((record) => record.kind === "topics").slice(0, 2);
    await withClient((client) => seedDatabase(client, { mode: "bootstrap", records }));
    const next = await childCatalogue();
    expect(next.rebuilt).toBe(true);
    expect(next.records.map((record) => record.id).sort()).toEqual(
      records.map((record) => record.id).sort(),
    );
  });
});
