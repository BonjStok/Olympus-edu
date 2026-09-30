import { env as workerEnv } from "cloudflare:workers";
import type { Features } from "@/lib/domain/types";

/**
 * Minimal subset of the R2 bucket API used by media upload/download. Keeping it narrow lets tests
 * provide an in-memory fake.
 */
export interface MediaObjectHead {
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
}
export interface MediaObject extends MediaObjectHead {
  body: ReadableStream | null;
}
export interface MediaBucket {
  put(
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<MediaObject | null>;
  head(key: string): Promise<MediaObjectHead | null>;
}

/** Server configuration read from Worker vars (Docker passes them from `.env`). */
export interface ServerEnv {
  DATABASE_URL: string;
  DB_HOST: string;
  DB_PORT: string;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  DB_SSL: string;
  ADMIN_PASSWORD: string;
  BOT_TOKEN: string;
  BOT_REMINDERS: string;
  MAX_BOT_NAME: string;
  TEST_API_USERNAME: string;
  TEST_API_PASSWORD: string;
  RUNNER_URL: string;
  RUNNER_TOKEN: string;
  BUCKET: MediaBucket | null;
}

const TEXT_KEYS = [
  "DATABASE_URL",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "DB_SSL",
  "ADMIN_PASSWORD",
  "BOT_TOKEN",
  "BOT_REMINDERS",
  "MAX_BOT_NAME",
  "TEST_API_USERNAME",
  "TEST_API_PASSWORD",
  "RUNNER_URL",
  "RUNNER_TOKEN",
] as const satisfies readonly (keyof ServerEnv)[];

type RawEnv = Record<string, unknown>;

function processEnv(): RawEnv {
  return typeof process === "undefined" ? {} : (process.env as RawEnv);
}

/**
 * Snapshot of the configuration for one request. Worker vars win; `process.env` is a fallback for
 * `vinext dev` and tests. Values are trimmed strings ("" when unset).
 */
export function getEnv(source: RawEnv = workerEnv as unknown as RawEnv): ServerEnv {
  const fallback = processEnv();
  const text = (key: string) => {
    const value = source[key] ?? fallback[key];
    return value === undefined || value === null ? "" : String(value).trim();
  };
  const values = Object.fromEntries(TEXT_KEYS.map((key) => [key, text(key)])) as Omit<
    ServerEnv,
    "BUCKET"
  >;
  const bucket = source.BUCKET;
  return { ...values, BUCKET: isMediaBucket(bucket) ? bucket : null };
}

function isMediaBucket(value: unknown): value is MediaBucket {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MediaBucket).put === "function" &&
    typeof (value as MediaBucket).get === "function"
  );
}

/**
 * On/off switch in the same format as the chat-bot (`bot/config.mjs`): on|true|1|yes enable it,
 * anything else (including an empty value) keeps it off.
 */
export function isFlagOn(value: string): boolean {
  return ["on", "true", "1", "yes"].includes(value.trim().toLowerCase());
}

/** MAX bot names look like `id1234567890_bot`; anything else is not put into links. */
const BOT_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export function features(env: ServerEnv): Features {
  const max = Boolean(env.BOT_TOKEN);
  return {
    runner: Boolean(env.RUNNER_URL),
    max,
    // Reminders are opt-in: MAX rules allow service messages only when agreed with MAX.
    reminders: max && isFlagOn(env.BOT_REMINDERS),
    botName: BOT_NAME_PATTERN.test(env.MAX_BOT_NAME) ? env.MAX_BOT_NAME : null,
  };
}
