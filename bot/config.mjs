// @ts-check
/**
 * Bot configuration from environment variables (see docs/BOT.md and .env.example).
 * Invalid values do not crash the process: they are collected in `problems`, the
 * service stays up and reports them in /health.
 */

import { DEFAULT_API_URL } from "./api.mjs";

export const MODES = /** @type {const} */ (["webhook", "polling", "off"]);
export const WEBHOOK_SECRET = /^[\w-]{5,256}$/;
export const DEFAULT_WEBHOOK_PATH = "/max/webhook";

/**
 * Update types the bot handles (also sent as `update_types` / `types`).
 */
export const UPDATE_TYPES = [
  "bot_started",
  "bot_stopped",
  "bot_removed",
  "dialog_removed",
  "message_created",
  "message_callback",
];

/**
 * @typedef {object} BotConfig
 * @property {string} token
 * @property {"webhook" | "polling" | "off" | "disabled"} mode effective mode ("disabled" = no token)
 * @property {string} apiUrl
 * @property {string} botName public bot name for `open_app.web_app`; empty → taken from GET /me
 * @property {string} host
 * @property {number} port
 * @property {string} webhookUrl
 * @property {string} webhookSecret
 * @property {string} webhookPath
 * @property {boolean} reminders BOT_REMINDERS=on
 * @property {number} remindersIntervalMs
 * @property {{ startHour: number, endHour: number }} reminderWindow Moscow hours, [start, end)
 * @property {boolean} registerCommands
 * @property {number} rateLimitRps
 * @property {number} chatIntervalMs
 * @property {string} logLevel
 * @property {Record<string, unknown> | null} database pg connection config; null = not configured
 * @property {string[]} problems configuration errors (the bot does not process updates)
 * @property {string[]} warnings
 */

/**
 * @param {string | undefined} value
 */
const text = (value) => String(value ?? "").trim();

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function int(value, fallback, min, max) {
  const n = Number(text(value));
  if (!text(value) || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {string | undefined} value
 * @param {boolean} fallback
 * @param {string} name
 * @param {string[]} problems
 */
function flag(value, fallback, name, problems) {
  const v = text(value).toLowerCase();
  if (!v) return fallback;
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  problems.push(`${name} must be on or off`);
  return fallback;
}

/**
 * Same variables as the web app (scripts/postgres-migrate.mjs, db/index.ts).
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, unknown> | null}
 */
export function databaseConfig(env) {
  const sslMode = text(env.DB_SSL).toLowerCase();
  const ssl =
    sslMode === "require"
      ? { rejectUnauthorized: false }
      : sslMode === "verify" || sslMode === "verify-full"
        ? true
        : undefined;
  const common = { ssl, connectionTimeoutMillis: 5_000, max: 5, idleTimeoutMillis: 30_000 };
  if (text(env.DATABASE_URL)) return { connectionString: text(env.DATABASE_URL), ...common };
  if (!text(env.DB_HOST) || !text(env.DB_USER) || !text(env.DB_NAME)) return null;
  return {
    host: text(env.DB_HOST),
    port: int(env.DB_PORT, 5432, 1, 65535),
    user: text(env.DB_USER),
    password: text(env.DB_PASSWORD),
    database: text(env.DB_NAME),
    ...common,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {BotConfig}
 */
export function loadConfig(env) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const token = text(env.BOT_TOKEN);
  const webhookUrl = text(env.BOT_WEBHOOK_URL);
  const webhookSecret = text(env.BOT_WEBHOOK_SECRET);

  const requestedMode = text(env.BOT_MODE).toLowerCase() || (webhookUrl ? "webhook" : "polling");
  /** @type {BotConfig["mode"]} */
  let mode = "off";
  if (MODES.includes(/** @type {any} */ (requestedMode))) {
    mode = /** @type {BotConfig["mode"]} */ (requestedMode);
  } else {
    problems.push(`BOT_MODE must be one of ${MODES.join(", ")}`);
  }
  if (!token && mode !== "off") mode = "disabled";

  let webhookPath = text(env.BOT_WEBHOOK_PATH) || DEFAULT_WEBHOOK_PATH;
  if (webhookUrl) {
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== "https:") problems.push("BOT_WEBHOOK_URL must use https://");
      if (url.port && url.port !== "443")
        problems.push("BOT_WEBHOOK_URL must use port 443 (MAX delivers webhooks only to 443)");
      webhookPath = url.pathname || DEFAULT_WEBHOOK_PATH;
    } catch {
      problems.push("BOT_WEBHOOK_URL is not a valid URL");
    }
  }
  if (!webhookPath.startsWith("/")) webhookPath = `/${webhookPath}`;
  if (mode === "webhook") {
    if (!webhookSecret) problems.push("BOT_WEBHOOK_SECRET is required in webhook mode");
    else if (!WEBHOOK_SECRET.test(webhookSecret))
      problems.push("BOT_WEBHOOK_SECRET must be 5–256 characters: A-Z a-z 0-9 _ -");
    if (!webhookUrl)
      warnings.push("BOT_WEBHOOK_URL is not set: the webhook subscription is not checked on start");
  }

  const reminders = flag(env.BOT_REMINDERS, false, "BOT_REMINDERS", problems);
  const registerCommands = flag(env.BOT_COMMANDS, true, "BOT_COMMANDS", problems);
  const database = databaseConfig(env);
  if (!database && mode !== "disabled" && mode !== "off")
    problems.push("PostgreSQL is not configured: set DATABASE_URL or DB_HOST/DB_USER/DB_NAME");

  let apiUrl = text(env.MAX_API_URL) || DEFAULT_API_URL;
  try {
    apiUrl = new URL(apiUrl).toString().replace(/\/+$/, "");
  } catch {
    problems.push("MAX_API_URL is not a valid URL");
    apiUrl = DEFAULT_API_URL;
  }

  return {
    token,
    mode,
    apiUrl,
    botName: text(env.MAX_BOT_NAME),
    host: text(env.BOT_HOST) || "0.0.0.0",
    port: int(env.BOT_PORT, 8090, 0, 65535),
    webhookUrl,
    webhookSecret,
    webhookPath,
    reminders,
    remindersIntervalMs: int(env.BOT_REMINDERS_INTERVAL_SECONDS, 600, 30, 3600) * 1000,
    reminderWindow: { startHour: 10, endHour: 20 },
    registerCommands,
    rateLimitRps: int(env.BOT_RATE_LIMIT_RPS, 25, 1, 30),
    chatIntervalMs: 1000,
    logLevel: text(env.BOT_LOG_LEVEL).toLowerCase() || "info",
    database,
    problems,
    warnings,
  };
}
