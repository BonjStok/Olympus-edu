import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/olympus/route";
import { Database, connectionConfig, withDatabase } from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";
import { ApiError } from "@/lib/server/errors";
import { FX } from "../support/fixtures";
import { bootstrap, configureEnv, guestToken, resetDatabase, rpc } from "../support/server";

beforeAll(async () => {
  await resetDatabase({ fixtures: true });
  configureEnv();
});
afterEach(() => vi.restoreAllMocks());

describe("request-scoped connection", () => {
  it("opens exactly one connection per request and closes it", async () => {
    const connect = vi.spyOn(Client.prototype, "connect");
    const end = vi.spyOn(Client.prototype, "end");
    const token = await guestToken(POST);
    connect.mockClear();
    end.mockClear();

    await bootstrap(GET, { token });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);

    connect.mockClear();
    end.mockClear();
    const [task] = FX.numbers;
    const checked = await rpc(POST, "check", { id: task.id, answer: task.answer }, { token });
    expect(checked.body).toMatchObject({ correct: true });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("does not connect at all for requests rejected before the database is needed", async () => {
    const connect = vi.spyOn(Client.prototype, "connect");
    const response = await rpc(POST, "session", {}, {}, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("Database", () => {
  it("commits and rolls back transactions on one connection", async () => {
    await withDatabase(getEnv(), async (db) => {
      await db.execute("CREATE TEMP TABLE t (v int)");
      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO t VALUES (1)");
        // Nested calls join the outer transaction.
        await tx.transaction((inner) => inner.execute("INSERT INTO t VALUES (2)"));
      });
      await expect(
        db.transaction(async (tx) => {
          await tx.execute("INSERT INTO t VALUES (3)");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const rows = await db.query<{ v: number }>("SELECT v FROM t ORDER BY v");
      expect(rows.map((row) => row.v)).toEqual([1, 2]);
      expect(await db.one("SELECT v FROM t WHERE v = 99")).toBeNull();
      expect(db.connected).toBe(true);
    });
  });

  it("parses BIGINT columns as numbers", async () => {
    await withDatabase(getEnv(), async (db) => {
      const row = await db.one<{ n: number }>("SELECT 1790000000000::bigint AS n");
      expect(row?.n).toBe(1_790_000_000_000);
    });
  });

  it("reports an unreachable database as 503 and refuses queries after close", async () => {
    const db = new Database(
      connectionConfig({ ...getEnv(), DATABASE_URL: "postgres://x:y@127.0.0.1:1/z" }),
    );
    const error = await db.query("SELECT 1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
    await db.close();
    await expect(db.query("SELECT 1")).rejects.toThrow(/closed/);
  });
});
