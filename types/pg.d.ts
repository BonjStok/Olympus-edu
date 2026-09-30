// Minimal typings for the parts of node-postgres used by the server.
declare module "pg" {
  export interface QueryResult<Row = Record<string, unknown>> {
    rows: Row[];
    rowCount: number | null;
  }
  export interface ClientConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    connectionTimeoutMillis?: number;
    keepAlive?: boolean;
    application_name?: string;
  }
  export const types: { setTypeParser(oid: number, parser: (value: string) => unknown): void };
  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    query<Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export interface PoolConfig extends ClientConfig {
    max?: number;
    idleTimeoutMillis?: number;
  }
  /** Used by the long-running chat-bot process (bot/store.mjs), never by the Worker. */
  export class Pool {
    constructor(config?: PoolConfig);
    query<Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
    on(event: "error", listener: (error: Error) => void): this;
  }
}
