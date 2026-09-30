// @ts-check
/**
 * Wiring of the bot service: configuration → database → MAX API → update delivery
 * (webhook or long polling) → router, plus the optional reminder scheduler and the
 * /health endpoint. `startBot()` is used by bot/server.mjs and by integration tests.
 */

import { createMaxApi } from "./api.mjs";
import { loadConfig, UPDATE_TYPES } from "./config.mjs";
import { createHttpServer, listen } from "./http.mjs";
import { createLogger, errorFields } from "./log.mjs";
import { createPoller } from "./polling.mjs";
import { createProcessor } from "./processor.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { createScheduler, runReminderTick } from "./reminders.mjs";
import { COMMANDS, createRouter } from "./router.mjs";
import { reminderScreen } from "./screens.mjs";
import { createPool, createStore } from "./store.mjs";
import { moscowToday } from "./time.mjs";

/** @typedef {import("./keyboard.mjs").AppTarget} AppTarget */

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      { once: true },
    );
  });
}

/**
 * @param {string | undefined} url
 */
function urlPassword(url) {
  try {
    return url ? decodeURIComponent(new URL(url).password) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {readonly string[] | null | undefined} a
 * @param {readonly string[]} b
 */
function sameSet(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Options other than `env` exist for tests: `now` is the business clock (dates,
 * reminder windows, stored timestamps); pacing, retries and de-duplication always
 * use real time.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   chatIntervalMs?: number,
 *   logger?: import("./log.mjs").Logger,
 *   port?: number,
 *   host?: string,
 *   retryDelayMs?: number,
 * }} [options]
 */
export async function startBot(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const realNow = () => Date.now();
  const config = loadConfig(env);
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      secrets: [config.token, config.webhookSecret, env.DB_PASSWORD, urlPassword(env.DATABASE_URL)],
      base: { service: "bot" },
    });
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  const startedAt = realNow();
  const lifecycle = new AbortController();

  /** @type {AppTarget} */
  const app = { webApp: config.botName || null, contactId: null };
  const state = {
    ready: false,
    /** @type {"missing" | "unchecked" | "ok" | "invalid" | "unreachable"} */
    token: config.token ? "unchecked" : "missing",
    /** @type {boolean | null} */
    subscribed: null,
    blockedByWebhook: false,
  };

  for (const warning of config.warnings) logger.warn("config_warning", { warning });
  for (const problem of config.problems) logger.error("config_problem", { problem });
  logger.info("bot_starting", {
    mode: config.mode,
    reminders: config.reminders ? "on" : "off",
    apiHost: new URL(config.apiUrl).host,
    webhookPath: config.webhookPath,
    botNameConfigured: Boolean(config.botName),
    database: Boolean(config.database),
  });

  const pool = config.database
    ? createPool(config.database, (error) => logger.error("db_pool_error", errorFields(error)))
    : null;
  const store = pool ? createStore(pool, { now }) : null;

  /** @type {{ at: number, value: string } | null} */
  let dbCache = null;
  async function checkDb() {
    if (!store) return "not_configured";
    if (dbCache && realNow() - dbCache.at < 10_000) return dbCache.value;
    let value = "error";
    try {
      value = (await store.checkSchema()) ? "ok" : "schema_missing";
    } catch (error) {
      logger.warn("db_check_failed", errorFields(error));
    }
    dbCache = { at: realNow(), value };
    return value;
  }

  const active =
    (config.mode === "webhook" || config.mode === "polling") &&
    Boolean(config.token) &&
    Boolean(store) &&
    config.problems.length === 0;

  const limiter = createRateLimiter({
    rps: config.rateLimitRps,
    chatIntervalMs: options.chatIntervalMs ?? config.chatIntervalMs,
    now: realNow,
    sleep: options.sleep,
  });
  const api = config.token
    ? createMaxApi({
        token: config.token,
        baseUrl: config.apiUrl,
        fetch: options.fetch,
        limiter,
        logger,
        sleep: options.sleep,
        now: realNow,
      })
    : null;

  const router =
    active && api && store
      ? createRouter({
          api,
          store,
          logger,
          app: () => app,
          remindersAvailable: config.reminders,
          now,
        })
      : null;
  const processor = createProcessor({
    handle: async (update) => router?.handle(update),
    logger,
    now: realNow,
  });

  const poller =
    active && api && config.mode === "polling"
      ? createPoller({
          api,
          types: UPDATE_TYPES,
          onUpdate: (update) => processor.push(update),
          logger,
          now: realNow,
          onFatal: () => {
            state.token = "invalid";
          },
        })
      : null;

  const scheduler =
    active && api && store && config.reminders
      ? createScheduler({
          intervalMs: config.remindersIntervalMs,
          logger,
          tick: () =>
            runReminderTick({
              store,
              logger,
              now,
              window: config.reminderWindow,
              send: (userId, body) => api.sendMessage({ userId }, body),
              render: (p) =>
                reminderScreen({ app, remindersAvailable: true, today: moscowToday(now()) }, p),
            }),
        })
      : null;

  async function health() {
    const db = await checkDb();
    /** @type {string} */
    let status;
    if (config.mode === "disabled") status = "disabled";
    else if (config.mode === "off") status = "off";
    else if (config.problems.length || state.token === "invalid") status = "error";
    else if (!state.ready) status = "starting";
    else if (db !== "ok" || state.token !== "ok") status = "degraded";
    else status = "ok";
    return {
      httpStatus: status === "error" ? 503 : 200,
      body: {
        status,
        mode: config.mode,
        ready: state.ready,
        token: state.token,
        db,
        bot: { name: app.webApp, id: app.contactId },
        delivery:
          config.mode === "webhook"
            ? { type: "webhook", path: config.webhookPath, subscribed: state.subscribed }
            : config.mode === "polling"
              ? {
                  type: "polling",
                  running: poller?.status.running ?? false,
                  lastPollAt: poller?.status.lastPollAt ?? null,
                  blockedByWebhook: state.blockedByWebhook,
                }
              : null,
        reminders: config.reminders ? "on" : "off",
        queue: processor.pending,
        problems: config.problems,
        uptimeSec: Math.round((realNow() - startedAt) / 1000),
      },
    };
  }

  const server = createHttpServer({
    webhookPath: config.webhookPath,
    webhookSecret: config.webhookSecret,
    webhookState: () =>
      !active || config.mode !== "webhook" ? "disabled" : state.ready ? "accept" : "not_ready",
    onUpdate: (update) => processor.push(update),
    health,
    logger,
  });
  const port = await listen(server, options.port ?? config.port, options.host ?? config.host);
  logger.info("bot_listening", { port });

  /** Identifies the bot (GET /me); retries until the API answers or the token is rejected. */
  async function connect() {
    if (!api) return false;
    while (!lifecycle.signal.aborted) {
      try {
        const me = await api.getMe();
        app.contactId = Number(me.user_id) || null;
        if (!app.webApp) app.webApp = me.username || null;
        state.token = "ok";
        logger.info("bot_identified", {
          botId: app.contactId,
          botName: app.webApp,
          nameSource: config.botName ? "MAX_BOT_NAME" : "GET /me",
        });
        if (!app.webApp)
          logger.warn("bot_name_unknown", {
            hint: "Set MAX_BOT_NAME: open_app buttons are omitted without it",
          });
        return true;
      } catch (error) {
        if (/** @type {any} */ (error)?.status === 401) {
          state.token = "invalid";
          logger.error("bot_token_invalid", errorFields(error));
          return false;
        }
        state.token = "unreachable";
        logger.error("bot_api_unreachable", { ...errorFields(error), retryInMs: retryDelayMs });
        await pause(retryDelayMs, lifecycle.signal);
      }
    }
    return false;
  }

  /** Waits for migration 0002 (applied by the web container on start). */
  async function waitForSchema() {
    let delayMs = Math.min(retryDelayMs, 1_000);
    while (!lifecycle.signal.aborted) {
      dbCache = null;
      const db = await checkDb();
      if (db === "ok") return true;
      logger.warn("db_not_ready", { db, retryInMs: delayMs });
      await pause(delayMs, lifecycle.signal);
      delayMs = Math.min(retryDelayMs, delayMs * 2);
    }
    return false;
  }

  async function setupDelivery() {
    if (!api) return;
    if (config.mode === "webhook") {
      if (!config.webhookUrl) return;
      const { subscriptions = [] } = await api.getSubscriptions();
      const existing = subscriptions.find((s) => s.url === config.webhookUrl);
      const others = subscriptions.filter((s) => s.url !== config.webhookUrl);
      if (others.length) logger.warn("webhook_other_subscriptions", { count: others.length });
      if (!existing || !sameSet(existing.update_types, UPDATE_TYPES)) {
        await api.subscribe({
          url: config.webhookUrl,
          secret: config.webhookSecret,
          update_types: UPDATE_TYPES,
        });
        logger.info("webhook_subscribed", { created: !existing });
      } else {
        logger.info("webhook_subscription_ok");
      }
      state.subscribed = true;
    } else if (config.mode === "polling") {
      try {
        const { subscriptions = [] } = await api.getSubscriptions();
        state.blockedByWebhook = subscriptions.length > 0;
        if (state.blockedByWebhook)
          logger.warn("polling_blocked_by_webhook", {
            count: subscriptions.length,
            hint: "Long polling does not work while a webhook subscription exists",
          });
      } catch (error) {
        logger.warn("subscriptions_check_failed", errorFields(error));
      }
      poller?.start();
    }
  }

  async function initialize() {
    if (!(await connect())) return;
    if (!(await waitForSchema())) return;
    if (config.registerCommands && api) {
      try {
        await api.setCommands(COMMANDS);
        logger.info("commands_registered", { count: COMMANDS.length });
      } catch (error) {
        logger.warn("commands_register_failed", errorFields(error));
      }
    }
    while (!lifecycle.signal.aborted) {
      try {
        await setupDelivery();
        break;
      } catch (error) {
        if (/** @type {any} */ (error)?.status === 401) {
          state.token = "invalid";
          logger.error("bot_token_invalid", errorFields(error));
          return;
        }
        logger.error("delivery_setup_failed", { ...errorFields(error), retryInMs: retryDelayMs });
        await pause(retryDelayMs, lifecycle.signal);
      }
    }
    if (lifecycle.signal.aborted) return;
    scheduler?.start();
    state.ready = true;
    logger.info("bot_ready", { mode: config.mode, reminders: config.reminders ? "on" : "off" });
  }

  const initialized = active
    ? initialize().catch((error) => logger.error("bot_init_failed", errorFields(error)))
    : Promise.resolve();

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    lifecycle.abort();
    await initialized;
    await poller?.stop();
    await scheduler?.stop();
    const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
    server.closeIdleConnections();
    await closed;
    await processor.drain(10_000);
    await pool?.end().catch(() => {});
    logger.info("bot_stopped_service");
  }

  return {
    config,
    logger,
    port,
    url: `http://127.0.0.1:${port}`,
    app,
    state,
    api,
    store,
    processor,
    poller,
    scheduler,
    health,
    /** Resolves when start-up (identification, schema, delivery) has finished. */
    initialized,
    stop,
  };
}

/** @typedef {Awaited<ReturnType<typeof startBot>>} BotService */
