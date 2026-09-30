// @ts-check
/**
 * HTTP endpoints of the bot service (port 8090 by default):
 * - GET /health – mode and state (token, database, delivery); 503 only on a hard error;
 * - POST <BOT_WEBHOOK_PATH> – MAX webhook. Checks `X-Max-Bot-Api-Secret`, answers
 *   200 immediately and handles the update asynchronously (MAX needs 200 within 30 s
 *   and retries otherwise).
 */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { errorFields } from "./log.mjs";

const MAX_BODY_BYTES = 1_000_000;

/**
 * Constant-time comparison of two secrets of any length.
 * @param {string} actual
 * @param {string} expected
 */
export function secretMatches(actual, expected) {
  if (!expected) return false;
  const a = createHash("sha256").update(String(actual)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(Object.assign(new Error("Payload too large"), { status: 413 }));
      req.resume();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      // Keep draining (bounded by the server request timeout) so a 413 can still be sent.
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES)
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * @typedef {"accept" | "not_ready" | "disabled"} WebhookState
 */

/**
 * @param {{
 *   webhookPath: string,
 *   webhookSecret: string,
 *   webhookState: () => WebhookState,
 *   onUpdate: (update: any) => unknown,
 *   health: () => Promise<{ httpStatus: number, body: unknown }>,
 *   logger: import("./log.mjs").Logger,
 * }} options
 */
export function createHttpServer(options) {
  const { webhookPath, webhookSecret, webhookState, onUpdate, health, logger } = options;

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function route(req, res) {
    const path = new URL(req.url || "/", "http://localhost").pathname;

    if (path === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD")
        return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      const result = await health();
      return sendJson(res, result.httpStatus, result.body);
    }

    if (path === webhookPath) {
      const state = webhookState();
      if (state === "disabled") return sendJson(res, 404, { error: "not_found" });
      if (req.method !== "POST")
        return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
      const header = req.headers["x-max-bot-api-secret"];
      if (!secretMatches(Array.isArray(header) ? header[0] : header || "", webhookSecret)) {
        logger.warn("webhook_rejected", { reason: "secret" });
        req.resume();
        return sendJson(res, 401, { error: "unauthorized" });
      }
      if (state === "not_ready") {
        // MAX retries failed deliveries (60 s, 150 s, …), nothing is lost.
        req.resume();
        return sendJson(res, 503, { error: "starting" }, { "Retry-After": "60" });
      }
      /** @type {unknown} */
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        const status = /** @type {any} */ (error)?.status === 413 ? 413 : 400;
        logger.warn("webhook_rejected", { reason: status === 413 ? "too_large" : "bad_json" });
        return sendJson(res, status, { error: status === 413 ? "too_large" : "bad_json" });
      }
      sendJson(res, 200, { ok: true });
      const p = /** @type {any} */ (payload);
      const updates = Array.isArray(p?.updates) ? p.updates : [p];
      setImmediate(() => {
        for (const update of updates) Promise.resolve(onUpdate(update)).catch(() => {});
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      logger.error("http_failed", errorFields(error));
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  return server;
}

/**
 * @param {http.Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>} the bound port
 */
export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
