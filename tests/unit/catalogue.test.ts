// Children's catalogue of `GET /api/olympus`: slim olympiad summaries, the per-isolate cache of the
// serialised catalogue and the bootstrap body built around it.
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapJson } from "@/lib/api/olympus/dispatcher";
import type {
  BootstrapResponse,
  ContentRecord,
  Olympiad,
  OlympiadDetailField,
  OlympiadSummary,
} from "@/lib/domain/types";
import type { Db, SqlValue } from "@/lib/server/db";
import {
  catalogueJson,
  CONTENT_VERSION_SQL,
  contentVersion,
  resetCatalogueCache,
} from "@/lib/services/catalogue";
import { catalogueSummary, olympiadSummary, publicSummary } from "@/lib/services/content";
import { readSeedBundle } from "../../scripts/seed.mjs";

const DETAIL_FIELDS: readonly OlympiadDetailField[] = [
  "description",
  "source",
  "verifiedAt",
  "image",
];

/**
 * Olympiad fields read by the calendar list and month grid (lib/ui/calendar.ts,
 * lib/ui/calendar-labels.ts, EventCard), «Главная», «Профиль» and the summary part of EventScreen.
 * `satisfies` keeps the list in step with the summary type.
 */
const LIST_FIELDS = [
  "id",
  "kind",
  "title",
  "demo",
  "subject",
  "subjects",
  "grades",
  "format",
  "region",
  "series",
  "stage",
  "registrationType",
  "url",
  "registrationStart",
  "deadline",
  "date",
  "dateEnd",
  "price",
  "featured",
] as const satisfies readonly (keyof OlympiadSummary)[];

/** Every field of the type is set: a new field fails to compile here until it is sorted out. */
const complete: Required<Olympiad> = {
  id: "complete",
  kind: "olympiads",
  title: "ВсОШ – математика – школьный этап",
  unpublished: false,
  demo: false,
  subject: "math",
  subjects: ["math", "info"],
  grades: [4, 5, 6],
  format: "online",
  region: "Москва",
  series: "vsosh-school-2026-math",
  stage: "Школьный этап",
  registrationType: "school",
  url: "https://siriusolymp.ru",
  registrationStart: "2026-09-01",
  deadline: "2026-10-01",
  date: "2026-10-10",
  dateEnd: "2026-10-12",
  price: 0,
  image: "https://example.ru/picture.png",
  featured: true,
  description: "Длинное описание олимпиады",
  source: "https://olimpiada.ru/activity/1",
  verifiedAt: "2026-09-20",
};

const bundle = readSeedBundle() as unknown as ContentRecord[];
const published = bundle.filter((record) => !record.unpublished);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("olympiad summary", () => {
  it("drops exactly the details-screen fields and keeps everything the lists use", () => {
    const summary = olympiadSummary(complete);
    for (const field of DETAIL_FIELDS) expect(summary).not.toHaveProperty(field);
    expect(Object.keys(summary).sort()).toEqual([...LIST_FIELDS, "unpublished"].sort());
    for (const field of LIST_FIELDS) expect(summary[field]).toEqual(complete[field]);
    // The source record is not modified.
    expect(complete.description).toBe("Длинное описание олимпиады");
  });

  it("loses nothing else on the real calendar", () => {
    const olympiads = published.filter((r): r is Olympiad => r.kind === "olympiads");
    expect(olympiads.length).toBeGreaterThan(400);
    for (const olympiad of olympiads) {
      const summary = catalogueSummary(olympiad);
      for (const field of DETAIL_FIELDS) expect(summary).not.toHaveProperty(field);
      const details = Object.fromEntries(
        DETAIL_FIELDS.filter((field) => field in olympiad).map((field) => [field, olympiad[field]]),
      );
      expect({ ...summary, ...details }).toEqual(olympiad);
    }
  });

  it("leaves other kinds as the evaluator API lists them", () => {
    for (const record of published.filter((r) => r.kind !== "olympiads"))
      expect(catalogueSummary(record)).toEqual(publicSummary(record));
    // GET /api/v1/content keeps complete olympiads.
    expect(publicSummary(complete)).toEqual(complete);
  });

  it("makes the bootstrap catalogue of the real content much smaller", () => {
    const before = bytes(JSON.stringify(published.map(publicSummary)));
    const after = bytes(JSON.stringify(published.map(catalogueSummary)));
    // 2026-09-29 content: 691 839 → 411 454 bytes (olympiads 532 KB → 252 KB).
    expect(after).toBeLessThan(before * 0.65);
    const olympiads = published.filter((r) => r.kind === "olympiads");
    expect(bytes(JSON.stringify(olympiads.map(catalogueSummary)))).toBeLessThan(
      bytes(JSON.stringify(olympiads)) * 0.55,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  kind: string;
  data: string;
  draft: string | null;
  deleted: number;
}

/** In-memory `records` table that counts what is asked of it. */
function fakeDb(records: ContentRecord[]) {
  const sql: string[] = [];
  const state = { live: records.length, gone: 0, updated: 1000, total: 1000 * records.length };
  let rows: Row[] = records.map((record) => ({
    id: record.id,
    kind: record.kind,
    data: JSON.stringify(record),
    draft: null,
    deleted: 0,
  }));
  const db: Db = {
    async query<R>(text: string, _params?: readonly SqlValue[]): Promise<R[]> {
      sql.push(text);
      if (text === CONTENT_VERSION_SQL)
        return [{ ...state, total: String(state.total) }] as unknown as R[];
      if (text.includes("FROM records WHERE deleted = 0")) return rows as unknown as R[];
      throw new Error(`unexpected query: ${text}`);
    },
    async one<R>(text: string, params?: readonly SqlValue[]): Promise<R | null> {
      return ((await db.query<R>(text, params))[0] as R | undefined) ?? null;
    },
    async execute() {
      return 0;
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return fn(db);
    },
  };
  return {
    db,
    sql,
    rowReads: () => sql.filter((text) => text !== CONTENT_VERSION_SQL).length,
    /** A write: the row changes and its `updated` is raised (as every write path does). */
    write(record: ContentRecord) {
      rows = rows.map((row) =>
        row.id === record.id ? { ...row, data: JSON.stringify(record) } : row,
      );
      state.total += 1;
    },
  };
}

const topic: ContentRecord = {
  id: "t1",
  kind: "topics",
  title: "Делимость",
  grade: 5,
  subject: "math",
  order: 1,
};
const draft: ContentRecord = { ...topic, id: "t2", unpublished: true };

beforeEach(() => resetCatalogueCache());

describe("catalogue cache", () => {
  it("reads the rows once and serves the same JSON while the content version is the same", async () => {
    const fake = fakeDb([complete, topic, draft]);
    const first = await catalogueJson(fake.db);
    expect(JSON.parse(first)).toEqual([olympiadSummary(complete), topic]);
    // The version is asked for before the rows.
    expect(fake.sql).toEqual([CONTENT_VERSION_SQL, expect.stringContaining("FROM records")]);

    const second = await catalogueJson(fake.db);
    expect(second).toBe(first);
    expect(fake.rowReads()).toBe(1);
    expect(fake.sql.filter((text) => text === CONTENT_VERSION_SQL)).toHaveLength(2);
  });

  it("rebuilds after a write changes the version", async () => {
    const fake = fakeDb([complete, topic]);
    await catalogueJson(fake.db);
    fake.write({ ...topic, title: "Остатки" });
    const json = await catalogueJson(fake.db);
    expect(fake.rowReads()).toBe(2);
    expect(JSON.parse(json)[1].title).toBe("Остатки");
    await catalogueJson(fake.db);
    expect(fake.rowReads()).toBe(2);
  });

  it("builds the version from the counts, the latest and the sum of `updated`", async () => {
    const fake = fakeDb([complete, topic]);
    expect(await contentVersion(fake.db)).toBe("2:0:1000:2000");
  });

  it("can be reset", async () => {
    const fake = fakeDb([topic]);
    await catalogueJson(fake.db);
    resetCatalogueCache();
    await catalogueJson(fake.db);
    expect(fake.rowReads()).toBe(2);
  });
});

describe("bootstrap body", () => {
  it("splices the serialised catalogue into the per-user part", () => {
    const records = [olympiadSummary(complete), topic];
    const rest: Omit<BootstrapResponse, "records"> = {
      progress: { "registration:complete": { registered: true } },
      profile: { name: "Маша", photo: null, max: true, admin: false },
      features: { runner: true, max: true, reminders: false, botName: null },
      sessionToken: "token",
      serverTime: 1_790_000_000_000,
      runner: true,
      maxConnected: true,
    };
    const text = bootstrapJson(JSON.stringify(records), rest);
    expect(text).toBe(JSON.stringify({ records, ...rest }));
  });
});
