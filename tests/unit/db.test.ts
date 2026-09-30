import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, ClientConfig } from "pg";
import {
  connectionConfig,
  Database,
  parseJson,
  withDatabase,
  type DatabaseEnv,
} from "@/lib/server/db";
import { getEnv } from "@/lib/server/env";
import { ApiError } from "@/lib/server/errors";

const baseEnv: DatabaseEnv = {
  DATABASE_URL: "",
  DB_HOST: "",
  DB_PORT: "",
  DB_USER: "",
  DB_PASSWORD: "",
  DB_NAME: "",
  DB_SSL: "",
};

describe("connectionConfig", () => {
  it("prefers DATABASE_URL", () => {
    expect(
      connectionConfig({ ...baseEnv, DATABASE_URL: "postgres://u:p@db/x", DB_HOST: "ignored" }),
    ).toEqual({
      connectionString: "postgres://u:p@db/x",
      ssl: undefined,
      connectionTimeoutMillis: 5000,
      keepAlive: false,
      application_name: "olympus-web",
    });
  });

  it("builds a config from DB_* variables with the default port", () => {
    expect(
      connectionConfig({
        ...baseEnv,
        DB_HOST: "postgres",
        DB_USER: "olympus",
        DB_NAME: "olympus",
        DB_PASSWORD: "pw",
      }),
    ).toMatchObject({
      host: "postgres",
      port: 5432,
      user: "olympus",
      password: "pw",
      database: "olympus",
    });
    expect(
      connectionConfig({ ...baseEnv, DB_HOST: "h", DB_USER: "u", DB_NAME: "n", DB_PORT: "6543" })
        .port,
    ).toBe(6543);
  });

  it.each([
    ["require", { rejectUnauthorized: false }],
    ["REQUIRE", { rejectUnauthorized: false }],
    ["verify", true],
    ["verify-full", true],
    ["false", undefined],
    ["", undefined],
  ])("DB_SSL=%s → ssl %j", (mode, ssl) => {
    expect(
      connectionConfig({ ...baseEnv, DATABASE_URL: "postgres://x", DB_SSL: mode }).ssl,
    ).toEqual(ssl);
  });

  it("answers 503 DATABASE_NOT_CONFIGURED without configuration", () => {
    expect(() => connectionConfig({ ...baseEnv, DB_HOST: "h" })).toThrow(ApiError);
    try {
      connectionConfig(baseEnv);
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: "DATABASE_NOT_CONFIGURED" });
    }
  });
});

class FakeClient {
  log: string[] = [];
  ended = 0;
  errorListener: ((error: Error) => void) | null = null;
  constructor(
    readonly config: ClientConfig,
    private readonly failConnect = false,
  ) {}
  on(_event: "error", listener: (error: Error) => void) {
    this.errorListener = listener;
    return this;
  }
  async connect() {
    if (this.failConnect)
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    this.log.push("CONNECT");
  }
  async query(sql: string, params: readonly unknown[] = []) {
    this.log.push(sql);
    if (sql.startsWith("FAIL")) throw new Error("query failed");
    return { rows: [{ sql, params }], rowCount: 7 };
  }
  async end() {
    this.ended += 1;
  }
}

function database(options: { failConnect?: boolean } = {}) {
  const clients: FakeClient[] = [];
  const configFactory = vi.fn(() => ({ connectionString: "postgres://fake" }));
  const db = new Database(configFactory, (config) => {
    const client = new FakeClient(config, options.failConnect);
    clients.push(client);
    return client as unknown as Client;
  });
  return { db, clients, configFactory };
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("Database", () => {
  it("does not connect or read the configuration until the first query", async () => {
    const { db, clients, configFactory } = database();
    expect(db.connected).toBe(false);
    await db.close();
    expect(clients).toHaveLength(0);
    expect(configFactory).not.toHaveBeenCalled();
  });

  it("reuses one connection for all queries of a request", async () => {
    const { db, clients } = database();
    const [a, b] = await Promise.all([db.query("SELECT 1"), db.query("SELECT 2", ["x"])]);
    expect(await db.one<{ sql: string }>("SELECT 3")).toEqual({ sql: "SELECT 3", params: [] });
    expect(await db.execute("UPDATE t")).toBe(7);
    expect(a).toEqual([{ sql: "SELECT 1", params: [] }]);
    expect(b).toEqual([{ sql: "SELECT 2", params: ["x"] }]);
    expect(clients).toHaveLength(1);
    expect(clients[0].log[0]).toBe("CONNECT");
    expect(db.connected).toBe(true);
    await db.close();
    expect(clients[0].ended).toBe(1);
  });

  it("wraps a transaction in BEGIN/COMMIT and joins nested transactions", async () => {
    const { db, clients } = database();
    const result = await db.transaction(async (tx) => {
      await tx.execute("INSERT 1");
      return tx.transaction(async (inner) => {
        await inner.execute("INSERT 2");
        return "done";
      });
    });
    expect(result).toBe("done");
    expect(clients[0].log).toEqual(["CONNECT", "BEGIN", "INSERT 1", "INSERT 2", "COMMIT"]);
  });

  it("rolls back and rethrows when the transaction fails, then works again", async () => {
    const { db, clients } = database();
    await expect(
      db.transaction(async (tx) => {
        await tx.execute("INSERT 1");
        await tx.execute("FAIL");
      }),
    ).rejects.toThrow("query failed");
    expect(clients[0].log).toEqual(["CONNECT", "BEGIN", "INSERT 1", "FAIL", "ROLLBACK"]);
    await db.transaction(async (tx) => tx.execute("INSERT 3"));
    expect(clients[0].log.slice(-3)).toEqual(["BEGIN", "INSERT 3", "COMMIT"]);
  });

  it("reports an unreachable database as 503 without leaking details", async () => {
    const { db, clients } = database({ failConnect: true });
    let caught: unknown;
    try {
      await db.query("SELECT 1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 503, code: "DATABASE_UNAVAILABLE" });
    expect((caught as Error).message).not.toMatch(/ECONNREFUSED/);
    expect(clients[0].ended).toBe(1);
  });

  it("logs socket errors instead of crashing the process", async () => {
    const { db, clients } = database();
    await db.query("SELECT 1");
    clients[0].errorListener?.(new Error("socket closed"));
    expect(errorLog).toHaveBeenCalled();
  });

  it("refuses queries after close", async () => {
    const { db } = database();
    await db.close();
    await expect(db.query("SELECT 1")).rejects.toThrow(/closed/);
  });
});

describe("withDatabase", () => {
  it("never connects when the handler does not query", async () => {
    const env = { ...getEnv({}), DATABASE_URL: "", DB_HOST: "", DB_USER: "", DB_NAME: "" };
    await expect(withDatabase(env, async () => "ok")).resolves.toBe("ok");
  });

  it("reports missing configuration lazily on the first query", async () => {
    const env = { ...getEnv({}), DATABASE_URL: "", DB_HOST: "", DB_USER: "", DB_NAME: "" };
    await expect(withDatabase(env, (db) => db.query("SELECT 1"))).rejects.toMatchObject({
      status: 503,
      code: "DATABASE_NOT_CONFIGURED",
    });
  });

  it("reports a refused connection as 503", async () => {
    const env = { ...getEnv({}), DATABASE_URL: "postgres://u:p@127.0.0.1:1/none" };
    await expect(withDatabase(env, (db) => db.query("SELECT 1"))).rejects.toMatchObject({
      status: 503,
      code: "DATABASE_UNAVAILABLE",
    });
  });
});

describe("parseJson", () => {
  it("parses stored JSON and maps missing values to null", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson(null)).toBeNull();
    expect(parseJson(undefined)).toBeNull();
  });
});
