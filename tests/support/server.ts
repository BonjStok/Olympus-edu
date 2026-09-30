// Helpers for integration tests: database reset, request builders for the route handlers,
// signed MAX launch data, an in-memory R2 bucket and a fake code runner.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { env as workerEnv } from "cloudflare:workers";
import { migrate } from "../../scripts/postgres-migrate.mjs";
import { readSeedBundle, seedDatabase } from "../../scripts/seed.mjs";
import { withDatabase } from "@/lib/server/db";
import { getEnv, type MediaBucket, type MediaObject, type MediaObjectHead } from "@/lib/server/env";
import { launchParams, signLaunchParams } from "@/lib/server/max-auth";
import { loginLimiter } from "@/lib/server/rate-limit";
import { publishRecords } from "@/lib/services/admin";
import { FIXTURE_RECORDS } from "./fixtures";

export const ORIGIN = "http://localhost";
export const BOT_TOKEN = "test-bot-token:123456";
export const ADMIN_PASSWORD = "admin-password-for-tests";
export const TEST_API_PASSWORD = "test-api-password-123";

/** Baseline configuration of the app under test. Individual tests override what they need. */
export function configureEnv(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string | undefined> = {
    BOT_TOKEN,
    ADMIN_PASSWORD,
    TEST_API_USERNAME: "test_user",
    TEST_API_PASSWORD,
    RUNNER_URL: "",
    RUNNER_TOKEN: "",
    BOT_REMINDERS: "",
    MAX_BOT_NAME: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  loginLimiter.clear();
}

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * SQL expression that turns the raw token parameter `$1` into the stored session key (SHA-256 hex,
 * computed by PostgreSQL – the same expression as migration 0003).
 */
export const BY_TOKEN = "encode(sha256(convert_to($1, 'UTF8')), 'hex')";

export async function sql<Row = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<Row[]> {
  return withClient(async (client) => (await client.query<Row>(text, params)).rows);
}

export interface ResetOptions {
  /** Bootstrap the real content bundle (lib/seed.json). Default: true. */
  seed?: boolean;
  /** Publish the synthetic course of tests/support/fixtures.ts on top. Default: false. */
  fixtures?: boolean;
}

/**
 * Drops all tables, applies the migrations and (optionally) bootstraps the real content bundle
 * and the test fixtures.
 */
export async function resetDatabase(options: ResetOptions = {}): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      "DROP TABLE IF EXISTS records, revisions, sessions, progress, imports, _olympus_migrations CASCADE",
    );
    await migrate(client, { log: () => undefined });
    if (options.seed !== false)
      await seedDatabase(client, { mode: "bootstrap", records: readSeedBundle() });
  });
  if (options.fixtures) await installFixtures();
}

/** Ids of the published records of the real content bundle (what children see after a seed). */
export function publishedBundleIds(): string[] {
  return (readSeedBundle() as { id: string; unpublished?: boolean }[])
    .filter((record) => !record.unpublished)
    .map((record) => record.id);
}

/**
 * Publishes the fixture course through the admin import code path (validation, links to topics,
 * grade/subject inherited from the topic), in one transaction.
 */
export async function installFixtures(): Promise<void> {
  const env = getEnv();
  await withDatabase(env, (db) =>
    publishRecords({ db, env, actor: { userId: "admin:fixtures", admin: true }, now: Date.now() }, [
      ...FIXTURE_RECORDS,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface Auth {
  token?: string;
  /** Send the token as the cookie instead of the Authorization header. */
  cookie?: boolean;
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export async function toApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
    headers: response.headers,
  };
}

function authHeaders(auth: Auth = {}): Record<string, string> {
  if (!auth.token) return {};
  return auth.cookie
    ? { cookie: `olympus_session=${auth.token}` }
    : { authorization: `Bearer ${auth.token}` };
}

type Handler = (req: Request) => Promise<Response>;

export async function rpc<T = Record<string, unknown>>(
  post: Handler,
  action: string,
  params: Record<string, unknown> = {},
  auth: Auth = {},
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const req = new Request(`${ORIGIN}/api/olympus`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...authHeaders(auth),
      ...headers,
    },
    body: JSON.stringify({ action, ...params }),
  });
  return toApiResponse<T>(await post(req));
}

export async function bootstrap<T = Record<string, unknown>>(
  get: Handler,
  auth: Auth = {},
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const req = new Request(`${ORIGIN}/api/olympus`, {
    headers: { ...authHeaders(auth), ...headers },
  });
  return toApiResponse<T>(await get(req));
}

/** A fresh guest session token (via the RPC `session` action). */
export async function guestToken(post: Handler): Promise<string> {
  const response = await rpc<{ sessionToken: string }>(post, "session");
  if (response.status !== 200) throw new Error(`session failed: ${JSON.stringify(response.body)}`);
  return response.body.sessionToken;
}

export async function adminToken(post: Handler): Promise<string> {
  const guest = await guestToken(post);
  const response = await rpc<{ sessionToken: string }>(
    post,
    "admin-login",
    { password: ADMIN_PASSWORD },
    { token: guest },
  );
  if (response.status !== 200)
    throw new Error(`admin-login failed: ${JSON.stringify(response.body)}`);
  return response.body.sessionToken;
}

// ---------------------------------------------------------------------------
// MAX launch data
// ---------------------------------------------------------------------------

export interface InitDataOptions {
  user?: Record<string, unknown> | string;
  authDate?: number;
  extra?: Record<string, string>;
  botToken?: string;
}

/** Builds `initData` exactly as MAX does: URL-encoded pairs plus an HMAC-SHA256 `hash`. */
export async function signInitData(options: InitDataOptions = {}): Promise<string> {
  const user =
    typeof options.user === "string"
      ? options.user
      : JSON.stringify(options.user ?? { id: 4242, first_name: "Маша", last_name: "Иванова" });
  const fields: Record<string, string> = {
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: "AAH-test-query",
    user,
    ...options.extra,
  };
  const hash = await signLaunchParams(
    launchParams(Object.entries(fields)),
    options.botToken ?? BOT_TOKEN,
  );
  return [...Object.entries(fields), ["hash", hash]]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export class MemoryBucket implements MediaBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    this.objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
  }

  async head(key: string): Promise<MediaObjectHead | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      size: object.bytes.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: { contentType: object.contentType },
    };
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<MediaObject | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = options?.range
      ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : object.bytes;
    return {
      size: object.bytes.byteLength,
      httpEtag: `"${key}"`,
      httpMetadata: { contentType: object.contentType },
      body: new Response(bytes as BodyInit).body,
    };
  }
}

export function setBucket(bucket: MediaBucket | undefined): void {
  const bindings = workerEnv as unknown as Record<string, unknown>;
  if (bucket) bindings.BUCKET = bucket;
  else delete bindings.BUCKET;
}

export interface FakeRunner {
  url: string;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** HTTP server that plays the runner: `respond` decides status and body per request. */
export async function startFakeRunner(
  respond: (body: Record<string, unknown>) => {
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  },
): Promise<FakeRunner> {
  const requests: FakeRunner["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ headers: req.headers, body });
      const answer = respond(body);
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
