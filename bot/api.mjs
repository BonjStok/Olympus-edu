// @ts-check
/**
 * Minimal MAX Bot API client on top of `fetch` (no SDK, no extra dependencies).
 *
 * - Base URL `https://platform-api2.max.ru`; auth header `Authorization: <token>`
 *   (no `Bearer`, query-string tokens are not supported by the platform).
 * - The TLS chain of platform-api2.max.ru is issued by «Russian Trusted Sub CA»:
 *   run Node with NODE_EXTRA_CA_CERTS=bot/certs/russian_trusted_root_ca.crt.
 * - Errors are `{ code, message }` with HTTP 400/401/403/404/405/429/5xx.
 *   429, 5xx and network failures are retried with exponential backoff
 *   (honouring `Retry-After` when present); 403 and other 4xx are not.
 * Only methods and fields confirmed by the official OpenAPI schema are used.
 */

import { defaultSleep, noLimit } from "./rate-limit.mjs";
import { silentLogger } from "./log.mjs";

export const DEFAULT_API_URL = "https://platform-api2.max.ru";

/** @typedef {import("./rate-limit.mjs").RateLimiter} RateLimiter */
/** @typedef {import("./log.mjs").Logger} Logger */
/** @typedef {import("./keyboard.mjs").KeyboardAttachment} KeyboardAttachment */

/**
 * `NewMessageBody` (schema): text ≤ 4000, attachments, notify, format.
 * @typedef {object} NewMessageBody
 * @property {string} [text]
 * @property {KeyboardAttachment[]} [attachments]
 * @property {boolean} [notify]
 * @property {"markdown" | "html"} [format]
 */

/**
 * @typedef {{ user_id: number, first_name?: string, name?: string, username?: string | null, is_bot?: boolean }} BotInfo
 * @typedef {{ url: string, time?: number, update_types?: string[] | null }} Subscription
 * @typedef {{ name: string, description?: string }} BotCommand
 */

/**
 * @param {number} status
 */
function errorKind(status) {
  if (status === 0) return "network";
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "not_allowed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "http";
}

export class MaxApiError extends Error {
  /**
   * @param {{ status: number, code?: string, message: string, method: string, path: string, retryAfterMs?: number, cause?: unknown }} p
   */
  constructor({ status, code, message, method, path, retryAfterMs, cause }) {
    super(
      `MAX API ${method} ${path} failed: ${status || "network"} ${code || ""} ${message}`.trim(),
      {
        cause,
      },
    );
    this.name = "MaxApiError";
    this.status = status;
    this.code = code || errorKind(status);
    this.kind = errorKind(status);
    this.method = method;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
  }

  /** Worth retrying: rate limit, server error or no response at all. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** The user blocked/stopped the bot or the chat is not accessible (e.g. `chat.denied`). */
  get forbidden() {
    return this.status === 403;
  }
}

/**
 * @param {string | null} header
 * @param {() => number} now
 */
export function parseRetryAfter(header, now = Date.now) {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(0, ms), 60_000);
}

/**
 * @param {unknown} error
 */
function isAbort(error) {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * @typedef {object} RequestOptions
 * @property {Record<string, string | number | boolean | null | undefined>} [query]
 * @property {unknown} [body]
 * @property {string} [chatKey] per-chat pacing key (messages and callback answers)
 * @property {number} [timeoutMs]
 * @property {number} [retries]
 * @property {AbortSignal} [signal] external cancellation (shutdown)
 */

/**
 * @param {{
 *   token: string,
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 *   limiter?: RateLimiter,
 *   logger?: Logger,
 *   retries?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   now?: () => number,
 * }} options
 */
export function createMaxApi(options) {
  const token = options.token;
  if (!token) throw new Error("BOT_TOKEN is required for the MAX API client");
  const baseUrl = (options.baseUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const limiter = options.limiter ?? noLimit;
  const logger = options.logger ?? silentLogger;
  const maxRetries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const defaultTimeoutMs = options.timeoutMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  /**
   * Exponential backoff with jitter: 50–100 % of base·2^attempt, capped.
   * @param {number} attempt 0-based
   */
  function backoff(attempt) {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {RequestOptions} [opts]
   * @returns {Promise<any>}
   */
  async function request(method, path, opts = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
    /** @type {Record<string, string>} */
    const headers = { Authorization: token, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const retries = opts.retries ?? maxRetries;

    for (let attempt = 0; ; attempt++) {
      await limiter.acquire(opts.chatKey);
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? defaultTimeoutMs);
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      /** @type {MaxApiError} */
      let error;
      try {
        const response = await fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal,
        });
        const raw = await response.text();
        /** @type {any} */
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        if (response.ok) return json ?? {};
        error = new MaxApiError({
          status: response.status,
          code: typeof json?.code === "string" ? json.code : undefined,
          message:
            typeof json?.message === "string" ? json.message : raw.slice(0, 200) || "no body",
          method,
          path,
          retryAfterMs:
            response.status === 429
              ? parseRetryAfter(response.headers.get("retry-after"), now)
              : undefined,
        });
      } catch (cause) {
        if (opts.signal?.aborted && isAbort(cause)) throw cause;
        const timedOut = timeout.aborted;
        error = new MaxApiError({
          status: 0,
          code: timedOut ? "timeout" : "network",
          message: timedOut
            ? "request timed out"
            : /** @type {any} */ (cause)?.cause?.code ||
              String(/** @type {any} */ (cause)?.message),
          method,
          path,
          cause,
        });
      }
      if (!error.retryable || attempt >= retries) throw error;
      const delayMs = error.retryAfterMs ?? backoff(attempt);
      logger.warn("max_api_retry", {
        method,
        path,
        status: error.status,
        code: error.code,
        attempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  /**
   * @param {{ userId?: string | number, chatId?: string | number }} to
   */
  function recipient(to) {
    if (to.userId !== undefined)
      return { query: { user_id: String(to.userId) }, chatKey: `user:${to.userId}` };
    if (to.chatId !== undefined)
      return { query: { chat_id: String(to.chatId) }, chatKey: `chat:${to.chatId}` };
    throw new Error("Message recipient is required");
  }

  return {
    request,

    /** GET /me – bot id, name and public username. @returns {Promise<BotInfo>} */
    getMe: () => request("GET", "/me"),

    /**
     * POST /messages?user_id=… | chat_id=…
     * @param {{ userId?: string | number, chatId?: string | number }} to
     * @param {NewMessageBody} body
     */
    sendMessage(to, body) {
      const { query, chatKey } = recipient(to);
      return request("POST", "/messages", { query, body, chatKey });
    },

    /**
     * POST /answers?callback_id=… – acknowledge a callback button; optionally replace
     * the message (`message`) and/or show a one-time `notification`.
     * @param {string} callbackId
     * @param {{ message?: NewMessageBody, notification?: string }} answer
     * @param {string} [chatKey]
     */
    answerCallback(callbackId, answer, chatKey) {
      return request("POST", "/answers", {
        query: { callback_id: callbackId },
        body: answer,
        chatKey,
      });
    },

    /**
     * GET /updates – long polling (development only; not with an active webhook).
     * @param {{ marker?: number | null, timeout?: number, limit?: number, types?: string[] }} params
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ updates?: unknown[], marker?: number | null }>}
     */
    getUpdates(params, opts = {}) {
      const timeout = params.timeout ?? 30;
      return request("GET", "/updates", {
        query: {
          limit: params.limit ?? 100,
          timeout,
          marker: params.marker ?? undefined,
          types: params.types?.length ? params.types.join(",") : undefined,
        },
        timeoutMs: (timeout + 15) * 1000,
        retries: 0,
        signal: opts.signal,
      });
    },

    /** GET /subscriptions @returns {Promise<{ subscriptions?: Subscription[] }>} */
    getSubscriptions: () => request("GET", "/subscriptions"),

    /**
     * POST /subscriptions – creates or updates the webhook subscription.
     * @param {{ url: string, secret?: string, update_types?: string[] }} body
     */
    subscribe: (body) => request("POST", "/subscriptions", { body }),

    /**
     * PATCH /me/commands – the command hints shown by MAX clients.
     * @param {BotCommand[]} commands
     */
    setCommands: (commands) => request("PATCH", "/me/commands", { body: { commands } }),
  };
}

/** @typedef {ReturnType<typeof createMaxApi>} MaxApi */
