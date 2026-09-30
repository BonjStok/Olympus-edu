// The verified production calendar (501 olympiads) must pass validation and import atomically.
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import type { BootstrapResponse, ContentRecord, Olympiad } from "@/lib/domain/types";
import { readSeedBundle, seedDatabase } from "../../scripts/seed.mjs";
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

const calendar = JSON.parse(
  fs.readFileSync("tests/fixtures/olympiads.cleaned.json", "utf8"),
) as Omit<Olympiad, "kind">[];
const records = calendar.map((record) => ({ ...record, kind: "olympiads" }));

let admin: string;

async function olympiadCount(): Promise<number> {
  const [{ count }] = await sql<{ count: string }>(
    "SELECT COUNT(*) FROM records WHERE kind = 'olympiads'",
  );
  return Number(count);
}

beforeAll(async () => {
  // A database with the learning content but without a calendar yet (the bundle already ships
  // this calendar, so it is left out here to import it for real).
  await resetDatabase({ seed: false });
  const learning = (readSeedBundle() as unknown as ContentRecord[]).filter(
    (record) => record.kind !== "olympiads",
  );
  await withClient((client) => seedDatabase(client, { mode: "bootstrap", records: learning }));
  configureEnv();
  admin = await adminToken(POST);
});

describe("import of the production calendar", () => {
  it("covers the tricky cases of real data", () => {
    expect(records.length).toBeGreaterThan(500);
    expect(records.some((record) => record.format === "offline" && record.region === "")).toBe(
      true,
    );
    expect(records.some((record) => record.registrationType === "school" && !record.deadline)).toBe(
      true,
    );
    expect(records.some((record) => record.price === undefined)).toBe(true);
    expect(records.some((record) => /^https:\/\/xn--/.test(record.url))).toBe(true);
  });

  it("rolls back the whole batch when one record is invalid", async () => {
    expect(await olympiadCount()).toBe(0);
    const broken = [...records, { ...records[0], id: "broken-olympiad", region: "Атлантида" }];
    const response = await rpc(POST, "import", { records: broken }, { token: admin });
    expect(response).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    expect(response.body.error).toContain("broken-olympiad");
    expect(await olympiadCount()).toBe(0);
  });

  it("imports every record in one request and shows them to children", async () => {
    const started = Date.now();
    const response = await rpc(POST, "import", { records }, { token: admin });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ ok: true, count: records.length });
    expect(Date.now() - started).toBeLessThan(15_000);

    const child = await bootstrap<BootstrapResponse>(GET, { token: await guestToken(POST) });
    const ids = new Set(child.body.records.map((record) => record.id));
    expect(records.every((record) => ids.has(record.id))).toBe(true);
    expect(await olympiadCount()).toBe(records.length);
    // A first import creates no revisions: there was no previous version.
    expect(await sql("SELECT 1 FROM revisions")).toHaveLength(0);
  });

  it("re-imports the same calendar (updates are not duplicates of themselves)", async () => {
    const response = await rpc(POST, "import", { records }, { token: admin });
    expect(response.body).toEqual({ ok: true, count: records.length });
    const [{ count }] = await sql<{ count: string }>(
      "SELECT COUNT(*) FROM revisions WHERE record_id = $1",
      [records[0].id],
    );
    expect(Number(count)).toBe(1);
  });

  it("rejects a copy of a real olympiad under another id, but accepts another region", async () => {
    const original = records.find((record) => record.region !== "" && record.date !== "expected")!;
    const copy = await rpc(
      POST,
      "publish",
      { record: { ...original, id: "copy-of-real" } },
      { token: admin },
    );
    expect(copy).toMatchObject({ status: 409, body: { code: "DUPLICATE_OLYMPIAD" } });
    const otherRegion =
      original.region === "Республика Алтай" ? "Республика Тыва" : "Республика Алтай";
    const regional = await rpc(
      POST,
      "publish",
      { record: { ...original, id: "regional-edition", region: otherRegion } },
      { token: admin },
    );
    expect(regional.status).toBe(200);
  });
});
