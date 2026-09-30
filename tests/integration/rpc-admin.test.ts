import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import { GET as MEDIA } from "@/app/api/media/[id]/route";
import type { AdminRecord, BootstrapResponse, ContentRecord, Revision } from "@/lib/domain/types";
import {
  adminToken,
  bootstrap,
  configureEnv,
  guestToken,
  MemoryBucket,
  ORIGIN,
  resetDatabase,
  rpc,
  setBucket,
  sql,
} from "../support/server";
import { FX } from "../support/fixtures";

const olympiad = (overrides: Record<string, unknown> = {}) => ({
  kind: "olympiads",
  id: "olymp-a",
  title: "Олимпиада «Кенгуру»",
  subject: "math",
  grades: [4, 5],
  format: "online",
  region: "",
  deadline: "2026-11-01",
  date: "2026-11-10",
  url: "https://example.org/register",
  source: "https://example.org/rules",
  verifiedAt: "2026-09-01",
  ...overrides,
});

let admin: string;

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  configureEnv();
  admin = await adminToken(POST);
});
beforeEach(() => configureEnv());
afterEach(() => setBucket(undefined));

async function adminRecord(id: string): Promise<AdminRecord | undefined> {
  const response = await bootstrap<BootstrapResponse>(GET, { token: admin });
  return (response.body.records as AdminRecord[]).find((record) => record.id === id);
}

async function childSees(id: string): Promise<boolean> {
  const response = await bootstrap<BootstrapResponse>(GET, { token: await guestToken(POST) });
  return response.body.records.some((record) => record.id === id);
}

describe("admin-only actions", () => {
  it.each(["history", "restore", "delete", "deleted", "draft", "publish", "import", "upload"])(
    "%s is forbidden for a child",
    async (action) => {
      const response = await rpc(
        POST,
        action,
        { id: FX.mathTopic, revisionId: "x", record: {}, records: [] },
        {
          token: await guestToken(POST),
        },
      );
      expect(response).toMatchObject({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    },
  );

  it("answers unknown actions with 400 before any access check", async () => {
    const child = await guestToken(POST);
    for (const action of ["drop-tables", "admin-panel", "publishAll"]) {
      const response = await rpc(POST, action, {}, { token: child });
      expect(response).toMatchObject({ status: 400, body: { code: "UNKNOWN_ACTION" } });
    }
    expect(await rpc(POST, "no-such-action")).toMatchObject({
      status: 400,
      body: { code: "UNKNOWN_ACTION" },
    });
  });

  it("needs a session at all", async () => {
    const response = await rpc(POST, "deleted");
    expect(response).toMatchObject({ status: 401, body: { code: "SESSION_EXPIRED" } });
  });
});

describe("draft → publish → history → restore → delete", () => {
  it("keeps a new draft invisible until it is published", async () => {
    expect((await rpc(POST, "draft", { record: olympiad() }, { token: admin })).body).toEqual({
      ok: true,
      count: 1,
    });
    expect(await adminRecord("olymp-a")).toMatchObject({
      unpublished: true,
      draft: { id: "olymp-a" },
    });
    expect(await childSees("olymp-a")).toBe(false);

    const published = await rpc(
      POST,
      "publish",
      { record: { ...olympiad(), draft: null, unpublished: true } },
      { token: admin },
    );
    expect(published.body).toEqual({ ok: true, count: 1 });
    const record = await adminRecord("olymp-a");
    expect(record).not.toHaveProperty("unpublished");
    expect(record?.draft).toBeNull();
    expect(await childSees("olymp-a")).toBe(true);
  });

  it("stores a draft of a published record without changing what children see", async () => {
    await rpc(
      POST,
      "draft",
      { record: olympiad({ title: "Кенгуру – новая версия" }) },
      { token: admin },
    );
    const record = await adminRecord("olymp-a");
    expect(record?.title).toBe("Олимпиада «Кенгуру»");
    expect(record?.draft?.title).toBe("Кенгуру – новая версия");
  });

  it("keeps revisions and restores one as a draft", async () => {
    await rpc(POST, "publish", { record: olympiad({ title: "Кенгуру 2" }) }, { token: admin });
    const history = await rpc<{ history: Revision[] }>(
      POST,
      "history",
      { id: "olymp-a" },
      { token: admin },
    );
    expect(history.body.history.length).toBeGreaterThanOrEqual(2);
    const original = history.body.history.find((item) => item.data.title === "Олимпиада «Кенгуру»");
    expect(original).toBeDefined();
    expect(
      (await rpc(POST, "restore", { revisionId: original!.id }, { token: admin })).body,
    ).toEqual({ ok: true });
    const record = await adminRecord("olymp-a");
    expect(record?.title).toBe("Кенгуру 2");
    expect(record?.draft?.title).toBe("Олимпиада «Кенгуру»");
    const missing = await rpc(
      POST,
      "restore",
      { revisionId: "no-such-revision" },
      { token: admin },
    );
    expect(missing).toMatchObject({ status: 404, body: { code: "REVISION_NOT_FOUND" } });
  });

  it("soft-deletes, lists deleted records and restores them only as drafts", async () => {
    expect((await rpc(POST, "delete", { id: "olymp-a" }, { token: admin })).body).toEqual({
      ok: true,
    });
    expect(await adminRecord("olymp-a")).toBeUndefined();
    const deleted = await rpc<{ deleted: ContentRecord[] }>(POST, "deleted", {}, { token: admin });
    expect(deleted.body.deleted.map((record) => record.id)).toContain("olymp-a");
    const again = await rpc(POST, "delete", { id: "olymp-a" }, { token: admin });
    expect(again).toMatchObject({ status: 404, body: { code: "RECORD_NOT_FOUND" } });

    const history = await rpc<{ history: Revision[] }>(
      POST,
      "history",
      { id: "olymp-a" },
      { token: admin },
    );
    await rpc(POST, "restore", { revisionId: history.body.history[0].id }, { token: admin });
    expect(await adminRecord("olymp-a")).toMatchObject({ unpublished: true });
    expect(await childSees("olymp-a")).toBe(false);
  });
});

describe("validation", () => {
  it.each([
    ["an unknown region", { region: "Атлантида" }],
    ["region 'none'", { region: "none" }],
    ["an http source", { source: "http://example.org" }],
    ["a deadline after the date", { deadline: "2026-12-01" }],
    ["dateEnd before date", { dateEnd: "2026-11-01" }],
    ["a bad registrationType", { registrationType: "email" }],
    ["a bad series", { series: "Vsosh 2026" }],
    ["subjects outside the list", { subjects: ["math", "art"] }],
    ["a missing deadline for link registration", { deadline: undefined }],
    ["a bad verifiedAt", { verifiedAt: "2026-02-30" }],
  ])("rejects an olympiad with %s", async (_name, overrides) => {
    const response = await rpc(
      POST,
      "publish",
      { record: olympiad({ id: "olymp-invalid", ...overrides }) },
      { token: admin },
    );
    expect(response).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    expect(typeof response.body.error).toBe("string");
  });

  it("accepts school registration without a deadline and a multi-day event", async () => {
    const response = await rpc(
      POST,
      "publish",
      {
        record: olympiad({
          id: "olymp-school",
          title: "Школьный этап",
          region: "Республика Алтай",
          registrationType: "school",
          deadline: undefined,
          dateEnd: "2026-11-12",
          series: "vsosh-school-2026-math",
        }),
      },
      { token: admin },
    );
    expect(response.status).toBe(200);
  });

  it("rejects duplicate olympiads with 409, but allows other regions", async () => {
    await rpc(
      POST,
      "publish",
      { record: olympiad({ id: "olymp-dup-1", title: "Турнир городов" }) },
      { token: admin },
    );
    const duplicate = await rpc(
      POST,
      "publish",
      { record: olympiad({ id: "olymp-dup-2", title: "  турнир   ГОРОДОВ " }) },
      { token: admin },
    );
    expect(duplicate).toMatchObject({ status: 409, body: { code: "DUPLICATE_OLYMPIAD" } });
    expect(duplicate.body.error).toContain("olymp-dup-1");
    const otherRegion = await rpc(
      POST,
      "publish",
      {
        record: olympiad({
          id: "olymp-dup-3",
          title: "Турнир городов",
          region: "Республика Алтай",
        }),
      },
      { token: admin },
    );
    expect(otherRegion.status).toBe(200);
    // Editing the same record is not a duplicate of itself.
    const edit = await rpc(
      POST,
      "publish",
      { record: olympiad({ id: "olymp-dup-1", title: "Турнир городов" }) },
      { token: admin },
    );
    expect(edit.status).toBe(200);
    // A deleted olympiad does not block a new one.
    await rpc(POST, "delete", { id: "olymp-dup-1" }, { token: admin });
    const replacement = await rpc(
      POST,
      "publish",
      { record: olympiad({ id: "olymp-dup-4", title: "Турнир городов" }) },
      { token: admin },
    );
    expect(replacement.status).toBe(200);
  });

  it("checks links between records and inherits grade/subject from the topic", async () => {
    const orphan = await rpc(
      POST,
      "publish",
      {
        record: {
          kind: "lessons",
          id: "orphan",
          title: "Сирота",
          topicId: "no-topic",
          blocks: [{ type: "text", value: "x" }],
        },
      },
      { token: admin },
    );
    expect(orphan).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    expect(orphan.body.error).toContain("no-topic");

    const lesson = await rpc(
      POST,
      "publish",
      {
        record: {
          kind: "lessons",
          id: "inherit-lesson",
          title: "Наследник",
          topicId: FX.grade5Topic.id,
          blocks: [{ type: "text", value: "x" }],
        },
      },
      { token: admin },
    );
    expect(lesson.status).toBe(200);
    expect(await adminRecord("inherit-lesson")).toMatchObject({
      grade: FX.grade5Topic.grade,
      subject: FX.grade5Topic.subject,
    });

    const mismatch = await rpc(
      POST,
      "publish",
      {
        record: {
          kind: "mock-tests",
          id: "bad-mock",
          title: "Смесь",
          olympiad: "x",
          grade: 4,
          subject: "math",
          minutes: 5,
          taskIds: [FX.grade5Task.id],
        },
      },
      { token: admin },
    );
    expect(mismatch).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    expect(mismatch.body.error).toContain(FX.grade5Task.id);
    // The same mock with a task of its own grade and subject is fine.
    const matching = await rpc(
      POST,
      "publish",
      {
        record: {
          kind: "mock-tests",
          id: "good-mock",
          title: "Своё",
          olympiad: "x",
          grade: 4,
          subject: "math",
          minutes: 5,
          taskIds: [FX.numbers[0].id],
        },
      },
      { token: admin },
    );
    expect(matching.status).toBe(200);
  });

  it("refuses to reuse an id of another kind", async () => {
    const response = await rpc(
      POST,
      "publish",
      { record: olympiad({ id: FX.mathTopic }) },
      { token: admin },
    );
    expect(response).toMatchObject({ status: 409, body: { code: "KIND_CONFLICT" } });
  });
});

describe("import", () => {
  it("publishes a batch atomically (all or nothing)", async () => {
    const batch = [
      { kind: "topics", id: "import-topic", title: "Импорт", grade: 6, subject: "info", order: 50 },
      {
        kind: "tasks",
        id: "import-task",
        title: "Импорт 1",
        topicId: "import-topic",
        type: "number",
        prompt: "1+1",
        answer: "2",
        solution: "2",
      },
    ];
    const bad = await rpc(
      POST,
      "import",
      {
        records: [
          ...batch,
          { kind: "tasks", id: "import-bad", title: "", topicId: "import-topic" },
        ],
      },
      { token: admin },
    );
    expect(bad).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    expect(await adminRecord("import-topic")).toBeUndefined();

    const ok = await rpc(POST, "import", { records: batch }, { token: admin });
    expect(ok.body).toEqual({ ok: true, count: 2 });
    expect(await adminRecord("import-task")).toMatchObject({ grade: 6, subject: "info" });
  });

  it.each([[[]], ["nope"], [null]])("rejects %j", async (records) => {
    const response = await rpc(POST, "import", { records }, { token: admin });
    expect(response).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
  });

  it("rejects duplicate ids inside one file", async () => {
    const topic = { kind: "topics", id: "same", title: "Одна", grade: 4, subject: "math" };
    const response = await rpc(POST, "import", { records: [topic, topic] }, { token: admin });
    expect(response).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
  });

  it("accepts large admin bodies beyond the regular 256 KB limit", async () => {
    const records = Array.from({ length: 150 }, (_, index) => ({
      kind: "topics",
      id: `bulk-${index}`,
      title: `Тема ${index}`,
      grade: 4,
      subject: "math",
      description: "д".repeat(2_000),
    }));
    const response = await rpc(POST, "import", { records }, { token: admin });
    expect(response.body).toEqual({ ok: true, count: 150 });
    const [{ count }] = await sql<{ count: string }>(
      "SELECT COUNT(*) FROM revisions WHERE record_id LIKE 'bulk-%'",
    );
    expect(Number(count)).toBe(0);
  });
});

describe("upload", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]);

  it("stores a file in the bucket and serves it back, with ranges", async () => {
    const bucket = new MemoryBucket();
    setBucket(bucket);
    const response = await rpc<{ url: string; id: string; type: string; size: number }>(
      POST,
      "upload",
      { base64: png.toString("base64"), type: "image/png" },
      { token: admin },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      url: `/api/media/${response.body.id}`,
      id: expect.any(String),
      type: "image/png",
      size: 72,
    });
    expect(bucket.objects.get(response.body.id)?.contentType).toBe("image/png");

    const params = { params: Promise.resolve({ id: response.body.id }) };
    const full = await MEDIA(new Request(`${ORIGIN}${response.body.url}`), params);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/png");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await full.arrayBuffer())).toEqual(png);

    const partial = await MEDIA(
      new Request(`${ORIGIN}${response.body.url}`, { headers: { range: "bytes=0-7" } }),
      params,
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-7/72");
    expect((await partial.arrayBuffer()).byteLength).toBe(8);

    const unsatisfiable = await MEDIA(
      new Request(`${ORIGIN}${response.body.url}`, { headers: { range: "bytes=500-" } }),
      params,
    );
    expect(unsatisfiable.status).toBe(416);
  });

  it.each([
    [
      "an unsupported type",
      { base64: png.toString("base64"), type: "text/html" },
      415,
      "UNSUPPORTED_FILE_TYPE",
    ],
    [
      "a mismatched signature",
      { base64: Buffer.from("<html>").toString("base64"), type: "image/png" },
      422,
      "INVALID_FILE",
    ],
    ["broken base64", { base64: "!!!", type: "image/png" }, 422, "INVALID_FILE"],
    [
      "a file over 8 MB",
      { base64: "A".repeat(11_300_000), type: "image/png" },
      413,
      "FILE_TOO_LARGE",
    ],
  ])("rejects %s", async (_name, params, status, code) => {
    setBucket(new MemoryBucket());
    const response = await rpc(POST, "upload", params, { token: admin });
    expect(response).toMatchObject({ status, body: { code } });
  });

  it("answers 503 without a bucket and 404 for unknown media", async () => {
    const response = await rpc(
      POST,
      "upload",
      { base64: png.toString("base64"), type: "image/png" },
      { token: admin },
    );
    expect(response).toMatchObject({ status: 503, body: { code: "STORAGE_UNAVAILABLE" } });
    setBucket(new MemoryBucket());
    const missing = await MEDIA(new Request(`${ORIGIN}/api/media/0000000000000000000000`), {
      params: Promise.resolve({ id: "0000000000000000000000" }),
    });
    expect(missing.status).toBe(404);
    const invalid = await MEDIA(new Request(`${ORIGIN}/api/media/..`), {
      params: Promise.resolve({ id: ".." }),
    });
    expect(invalid.status).toBe(404);
  });
});
