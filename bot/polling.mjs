// @ts-check
/**
 * Long polling (`GET /updates`) for local development. The platform recommends
 * webhooks for production, and polling does not work while a webhook subscription
 * is active.
 *
 * Marker handling: every response carries `marker`, a pointer to the next update;
 * passing it on the next request commits everything before it. The poller waits
 * until a batch has been handled before committing it, so a crash replays the batch
 * instead of losing it (duplicates are filtered by the processor).
 */

import { errorFields } from "./log.mjs";

/** @typedef {import("./router.mjs").MaxUpdate} MaxUpdate */

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
 * @param {{
 *   api: Pick<import("./api.mjs").MaxApi, "getUpdates">,
 *   types: string[],
 *   onUpdate: (update: MaxUpdate) => Promise<unknown>,
 *   logger: import("./log.mjs").Logger,
 *   timeoutSec?: number,
 *   limit?: number,
 *   onFatal?: (error: unknown) => void,
 *   now?: () => number,
 * }} options
 */
export function createPoller(options) {
  const { api, types, onUpdate, logger } = options;
  const timeoutSec = options.timeoutSec ?? 30;
  const limit = options.limit ?? 100;
  const now = options.now ?? (() => Date.now());
  /** @type {number | null} */
  let marker = null;
  let stopped = true;
  const controller = { current: new AbortController() };
  /** @type {Promise<void> | null} */
  let loop = null;
  const status = {
    running: false,
    /** @type {number | null} */
    lastPollAt: null,
    received: 0,
    failures: 0,
  };

  async function run() {
    let failures = 0;
    while (!stopped) {
      const signal = controller.current.signal;
      try {
        const response = await api.getUpdates(
          { marker, timeout: timeoutSec, limit, types },
          { signal },
        );
        failures = 0;
        status.lastPollAt = now();
        const updates = Array.isArray(response?.updates) ? response.updates : [];
        status.received += updates.length;
        await Promise.all(updates.map((u) => onUpdate(/** @type {MaxUpdate} */ (u))));
        const next = Number(response?.marker);
        if (response?.marker !== null && response?.marker !== undefined && Number.isFinite(next))
          marker = next;
      } catch (error) {
        if (stopped) break;
        const status401 = /** @type {any} */ (error)?.status === 401;
        if (status401) {
          logger.error("polling_unauthorized", errorFields(error));
          options.onFatal?.(error);
          stopped = true;
          break;
        }
        failures += 1;
        status.failures += 1;
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
        logger.warn("polling_failed", { ...errorFields(error), delayMs });
        await pause(delayMs, signal);
      }
    }
    status.running = false;
  }

  return {
    status,
    /** Marker that will be sent with the next request. */
    get marker() {
      return marker;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      status.running = true;
      controller.current = new AbortController();
      loop = run();
    },
    async stop() {
      stopped = true;
      controller.current.abort();
      await loop;
    },
  };
}
