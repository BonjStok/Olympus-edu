import { describe, expect, it } from "vitest";
import {
  SyncError,
  canonicalJson,
  formatSummary,
  parseCliArgs,
  parseDeletions,
  parseKinds,
  planSync,
} from "../../scripts/sync-content.mjs";
import type { ContentRecord } from "@/lib/domain/types";

const topic = (id: string, title = "Тема", extra: Record<string, unknown> = {}) =>
  ({ id, kind: "topics", title, grade: 4, subject: "math", order: 1, ...extra }) as ContentRecord;
const task = (id: string, topicId = "t1") =>
  ({
    id,
    kind: "tasks",
    title: "Задача",
    grade: 4,
    subject: "math",
    topicId,
    order: 1,
    type: "number",
    prompt: "1+1?",
    answer: "2",
    solution: "2",
  }) as ContentRecord;
const mock = (id: string, taskIds: string[]) =>
  ({
    id,
    kind: "mock-tests",
    title: "Пробник",
    grade: 4,
    subject: "math",
    olympiad: "Тест",
    minutes: 10,
    taskIds,
  }) as ContentRecord;
const olympiad = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    kind: "olympiads",
    title: "Олимпиада «Звезда»",
    subject: "math",
    grades: [4],
    format: "online",
    region: "",
    url: "https://example.org",
    deadline: "2026-10-01",
    date: "2026-10-10",
    ...overrides,
  }) as ContentRecord;

type Row = { id: string; kind: string; data: string; draft: string | null; deleted: number };
const row = (record: ContentRecord, extra: Partial<Row> = {}): Row => ({
  id: record.id,
  kind: record.kind,
  data: JSON.stringify(record),
  draft: null,
  deleted: 0,
  ...extra,
});

const ALL = ["olympiads", "topics", "lessons", "tasks", "mock-tests"] as const;
const plan = (
  rows: Row[],
  seed: ContentRecord[],
  options: Partial<Parameters<typeof planSync>[2]> = {},
) => planSync(rows, seed, { kinds: [...ALL], deletions: [], restoreDeleted: false, ...options });

describe("canonicalJson", () => {
  it("ignores key order and undefined fields, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(
      canonicalJson({ a: { d: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
  });
});

describe("arguments", () => {
  it("parses kinds", () => {
    expect(parseKinds(undefined)).toEqual([...ALL]);
    expect(parseKinds(" olympiads , tasks,olympiads")).toEqual(["olympiads", "tasks"]);
    expect(() => parseKinds("olympiads,users")).toThrow(SyncError);
    expect(() => parseKinds(",")).toThrow(/unknown kind/);
  });

  it("parses deletions in every supported shape", () => {
    expect(parseDeletions('["a", "b", "a"]')).toEqual([{ id: "a" }, { id: "b" }]);
    expect(
      parseDeletions('[{ "id": "a", "reason": "дубль" }, { "id": "b", "reason": 1 }]'),
    ).toEqual([{ id: "a", reason: "дубль" }, { id: "b" }]);
    expect(parseDeletions('{ "ids": ["x"] }')).toEqual([{ id: "x" }]);
    expect(() => parseDeletions("{")).toThrow(/invalid JSON/);
    expect(() => parseDeletions('{ "id": "x" }')).toThrow(/expected/);
    expect(() => parseDeletions('["../etc"]')).toThrow(/invalid id/);
    expect(() => parseDeletions("[42]")).toThrow(/invalid id/);
  });

  it("parses the command line (dry run by default)", () => {
    expect(parseCliArgs([])).toEqual({
      apply: false,
      kinds: [...ALL],
      deletionsFile: undefined,
      seedFile: "lib/seed.json",
      restoreDeleted: false,
      verbose: false,
      json: false,
      help: false,
    });
    expect(
      parseCliArgs([
        "--apply",
        "--kinds",
        "olympiads",
        "--deletions",
        "-",
        "--seed",
        "x.json",
        "--restore-deleted",
        "--verbose",
        "--json",
      ]),
    ).toMatchObject({
      apply: true,
      kinds: ["olympiads"],
      deletionsFile: "-",
      seedFile: "x.json",
      restoreDeleted: true,
      verbose: true,
      json: true,
    });
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(() => parseCliArgs(["--force"])).toThrow(SyncError);
    expect(() => parseCliArgs(["positional"])).toThrow(SyncError);
  });
});

describe("planSync", () => {
  it("creates new, updates changed and keeps identical records", () => {
    const rows = [row(topic("t1")), row(topic("t2")), row(topic("admin-made"))];
    const result = plan(rows, [
      topic("t1"),
      // Same content with another key order is not a change.
      { order: 1, subject: "math", grade: 4, title: "Тема", kind: "topics", id: "t2" },
      topic("t3"),
    ] as ContentRecord[]);
    expect(result.lists.created).toEqual(["t3"]);
    expect(result.lists.updated).toEqual([]);
    expect(result.byKind.topics).toMatchObject({ create: 1, unchanged: 2, extra: 1 });
    expect(result.lists.dbOnly).toEqual(["admin-made"]);

    const changed = plan(rows, [topic("t1", "Новая")]);
    expect(changed.lists.updated).toEqual(["t1"]);
    expect(changed.writes.map((record) => record.id)).toEqual(["t1"]);
  });

  it("syncs only the selected kinds", () => {
    const rows = [row(topic("t1")), row(olympiad("o1"))];
    const result = plan(rows, [topic("t1", "Новая"), olympiad("o1", { title: "Новая" })], {
      kinds: ["olympiads"],
    });
    expect(result.lists.updated).toEqual(["o1"]);
    expect(Object.keys(result.byKind)).toEqual(["olympiads"]);
    expect(result.seedRecords).toBe(1);
  });

  it("reports pending admin drafts and keeps records deleted in the database", () => {
    const rows = [
      row(topic("t1"), { draft: JSON.stringify(topic("t1", "Черновик")) }),
      row(topic("t2"), { deleted: 1 }),
    ];
    const seed = [topic("t1", "Новая"), topic("t2", "Новая")];
    const skipped = plan(rows, seed);
    expect(skipped.lists).toMatchObject({ updated: ["t1"], draftsKept: ["t1"] });
    expect(skipped.lists.skippedDeleted).toEqual(["t2"]);
    expect(skipped.writes.map((record) => record.id)).toEqual(["t1"]);

    const restored = plan(rows, seed, { restoreDeleted: true });
    expect(restored.lists.restored).toEqual(["t2"]);
    expect(restored.byKind.topics).toMatchObject({ update: 1, restore: 1 });
  });

  it("sorts deletion ids into deleted, already deleted, missing and other kinds", () => {
    const rows = [row(olympiad("o1")), row(olympiad("o2"), { deleted: 1 }), row(topic("t1"))];
    const result = plan(rows, [], {
      kinds: ["olympiads"],
      deletions: [{ id: "o1" }, { id: "o2" }, { id: "missing" }, { id: "t1" }],
    });
    expect(result.lists).toMatchObject({
      deleted: ["o1"],
      alreadyDeleted: ["o2"],
      notFound: ["missing"],
      otherKind: ["t1"],
      dbOnly: [],
    });
    expect(result.byKind.olympiads).toMatchObject({ delete: 1, extra: 0 });
  });

  it("refuses contradictions and kind conflicts", () => {
    expect(() => plan([], [topic("t1")], { deletions: [{ id: "t1" }] })).toThrow(
      /listed for deletion but present in the seed/,
    );
    expect(() => plan([row(olympiad("x"))], [topic("x")])).toThrow(/kind olympiads/);
  });

  it("checks links against the database as it will be", () => {
    // A new task of a topic that exists only in the database is fine.
    expect(plan([row(topic("t1"))], [task("k1")]).lists.created).toEqual(["k1"]);
    expect(() => plan([], [task("k1", "nope")])).toThrow(/тема nope не найдена/);
    // A mock test must not point to a task that is only in a non-selected kind of the seed.
    expect(() =>
      plan([row(topic("t1"))], [task("k1"), mock("m1", ["k1"])], { kinds: ["mock-tests"] }),
    ).toThrow(/задание k1 не найдено/);
  });

  it("refuses deletions that would leave dangling references", () => {
    const rows = [row(topic("t1")), row(task("k1")), row(mock("m1", ["k1"]))];
    expect(() => plan(rows, [], { deletions: [{ id: "k1" }] })).toThrow(/m1 → k1/);
    expect(() => plan(rows, [], { deletions: [{ id: "t1" }] })).toThrow(/k1 → t1/);
    // Deleting the mock test together with its task is consistent.
    expect(plan(rows, [], { deletions: [{ id: "m1" }, { id: "k1" }] }).deletes).toEqual([
      "m1",
      "k1",
    ]);
  });

  it("finds duplicate olympiads unless the old id is deleted", () => {
    const rows = [row(olympiad("old"))];
    const seed = [olympiad("new", { title: 'Олимпиада "Звезда"' })];
    expect(() => plan(rows, seed)).toThrow(/new repeats old/);
    expect(plan(rows, seed, { deletions: [{ id: "old" }] }).lists).toMatchObject({
      created: ["new"],
      deleted: ["old"],
    });
    // Regional editions of one series are not duplicates.
    const regional = olympiad("new", { region: "Республика Татарстан" });
    expect(plan(rows, [regional]).lists.created).toEqual(["new"]);
  });
});

describe("formatSummary", () => {
  const summary = (applied: boolean, overrides: Record<string, unknown> = {}) => ({
    applied,
    kinds: ["olympiads" as const],
    seedRecords: 2,
    byKind: {
      olympiads: {
        create: 1,
        update: 1,
        unchanged: 0,
        restore: 0,
        skippedDeleted: 0,
        delete: 1,
        extra: 0,
      },
    },
    created: ["a"],
    updated: Array.from({ length: 25 }, (_, i) => `u${i}`),
    restored: [],
    skippedDeleted: [],
    deleted: ["d"],
    alreadyDeleted: [],
    notFound: ["n"],
    otherKind: [],
    draftsKept: [],
    dbOnly: [],
    revisions: applied ? 26 : 0,
    ...overrides,
  });

  it("prints a dry run with a table and shortened id lists", () => {
    const text = formatSummary(summary(false), { deletionsFile: "ids.json" });
    expect(text).toContain("DRY RUN");
    expect(text).toContain("Deletions: ids.json");
    expect(text).toMatch(/olympiads\s+1\s+1\s+0\s+0\s+0\s+1\s+0/);
    expect(text).toContain("… and 5 more (--verbose)");
    expect(text).toContain("Deletion ids not found in the database (1): n");
    expect(text).toContain("27 records would change");
    expect(formatSummary(summary(false), { verbose: true })).toContain("u24");
  });

  it("prints the result of an applied sync and a no-op", () => {
    expect(formatSummary(summary(true))).toContain("Done: 27 records changed, 26 revisions saved.");
    const noop = summary(false, { created: [], updated: [], deleted: [] });
    expect(formatSummary(noop)).toContain("Nothing to change");
  });
});
