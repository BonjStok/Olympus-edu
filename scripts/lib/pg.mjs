// PostgreSQL connection helpers for Node scripts (migrations, seed). The web app itself uses
// lib/server/db.ts with the same environment variables.
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("pg").ClientConfig}
 */
export function pgConfig(env = process.env) {
  const sslMode = String(env.DB_SSL || "").toLowerCase();
  const ssl =
    sslMode === "require"
      ? { rejectUnauthorized: false }
      : sslMode === "verify" || sslMode === "verify-full"
        ? true
        : undefined;
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ssl };
  return {
    host: env.DB_HOST || "postgres",
    port: Number(env.DB_PORT || 5432),
    user: env.DB_USER || "olympus",
    password: env.DB_PASSWORD || "",
    database: env.DB_NAME || "olympus",
    ssl,
  };
}

/**
 * Connects with retries: in Docker the database may still be starting.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ attempts?: number; delayMs?: number }} [options]
 */
export async function connect(env = process.env, options = {}) {
  const { attempts = 30, delayMs = 1000 } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new pg.Client(pgConfig(env));
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError ?? new Error("PostgreSQL is unavailable");
}

/** @param {string} scriptUrl `import.meta.url` of the calling module */
export function isMain(scriptUrl) {
  return (
    Boolean(process.argv[1]) && scriptUrl === pathToFileURL(path.resolve(process.argv[1])).href
  );
}
