import { Client, types, type ClientConfig } from "pg";
import { ApiError } from "./errors";
import type { ServerEnv } from "./env";

// BIGINT columns hold millisecond timestamps and counters, far below Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (value: string) => Number(value));

export type SqlValue = string | number | boolean | null | readonly string[];

/** Everything services need from the database. Implemented by `Database`. */
export interface Db {
  query<Row>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  one<Row>(sql: string, params?: readonly SqlValue[]): Promise<Row | null>;
  /** Runs a statement and returns the number of affected rows. */
  execute(sql: string, params?: readonly SqlValue[]): Promise<number>;
  /** Runs `fn` inside BEGIN/COMMIT on the same connection. Nested calls join the outer transaction. */
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export type DatabaseEnv = Pick<
  ServerEnv,
  "DATABASE_URL" | "DB_HOST" | "DB_PORT" | "DB_USER" | "DB_PASSWORD" | "DB_NAME" | "DB_SSL"
>;

export function connectionConfig(env: DatabaseEnv): ClientConfig {
  const sslMode = env.DB_SSL.toLowerCase();
  const ssl =
    sslMode === "require"
      ? { rejectUnauthorized: false }
      : sslMode === "verify" || sslMode === "verify-full"
        ? true
        : undefined;
  const common = {
    ssl,
    connectionTimeoutMillis: 5_000,
    keepAlive: false,
    application_name: "olympus-web",
  };
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ...common };
  if (!env.DB_HOST || !env.DB_USER || !env.DB_NAME)
    throw new ApiError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "База данных не настроена: укажите DATABASE_URL или DB_HOST/DB_USER/DB_NAME",
    );
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ...common,
  };
}

/**
 * One PostgreSQL connection for one request.
 *
 * workerd binds sockets to the request that created them, so a module-global Pool/Client must not
 * be reused across requests. The connection is opened lazily on the first query (requests that
 * fail validation never touch the database) and closed by `withDatabase`.
 */
export class Database implements Db {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private inTransaction = false;
  private closed = false;

  /**
   * @param config connection settings, or a factory evaluated on first use so that requests which
   *   never reach the database do not fail on missing configuration
   */
  constructor(
    private readonly config: ClientConfig | (() => ClientConfig),
    private readonly createClient: (config: ClientConfig) => Client = (c) => new Client(c),
  ) {}

  /** True once a connection has been opened. */
  get connected(): boolean {
    return this.client !== null;
  }

  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    if (this.closed) throw new Error("Database connection is already closed");
    this.connecting ??= (async () => {
      const client = this.createClient(
        typeof this.config === "function" ? this.config() : this.config,
      );
      // A dropped socket must not crash the process; the next query reports the failure.
      client.on("error", (error) => console.error("[olympus] PostgreSQL connection error:", error));
      try {
        await client.connect();
      } catch (error) {
        await client.end().catch(() => undefined);
        console.error("[olympus] PostgreSQL connect failed:", error);
        throw new ApiError(
          503,
          "DATABASE_UNAVAILABLE",
          "База данных временно недоступна. Попробуйте ещё раз чуть позже",
        );
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async query<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    const client = await this.connection();
    const result = await client.query<Row>(sql, params);
    return result.rows ?? [];
  }

  async one<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row | null> {
    const rows = await this.query<Row>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<number> {
    const client = await this.connection();
    const result = await client.query(sql, params);
    return result.rowCount ?? 0;
  }

  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const client = await this.connection();
    await client.query("BEGIN");
    this.inTransaction = true;
    try {
      const result = await fn(this);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.connecting;
    const client = this.client ?? (pending ? await pending.catch(() => null) : null);
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }
}

/** Opens a request-scoped database, runs `fn` and always closes the connection. */
export async function withDatabase<T>(
  env: ServerEnv,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const db = new Database(() => connectionConfig(env));
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Parses a JSON column. Rows are always written by the server with JSON.stringify. */
export function parseJson<T>(value: string | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  return JSON.parse(value) as T;
}
