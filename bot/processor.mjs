// @ts-check
/**
 * In-process update queue.
 * - De-duplicates updates (webhook redeliveries, polling replays) for 24 h.
 * - Keeps the order of updates of one user; different users run in parallel
 *   up to `concurrency`.
 */

import { errorFields } from "./log.mjs";
import { updateKey, userOf } from "./router.mjs";

/** @typedef {import("./router.mjs").MaxUpdate} MaxUpdate */

/**
 * @param {{
 *   handle: (update: MaxUpdate) => Promise<unknown>,
 *   logger: import("./log.mjs").Logger,
 *   concurrency?: number,
 *   dedupeSize?: number,
 *   dedupeTtlMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createProcessor(options) {
  const { handle, logger } = options;
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const dedupeSize = options.dedupeSize ?? 5_000;
  const dedupeTtlMs = options.dedupeTtlMs ?? 24 * 3_600_000;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, number>} key → expiry; insertion order = age */
  const seen = new Map();
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();
  /** @type {(() => void)[]} */
  const waiting = [];
  let active = 0;
  let pending = 0;
  /** @type {(() => void)[]} */
  let idleWaiters = [];

  /** @param {string} key */
  function isDuplicate(key) {
    const t = now();
    const expiry = seen.get(key);
    if (expiry !== undefined && expiry > t) return true;
    seen.delete(key);
    seen.set(key, t + dedupeTtlMs);
    while (seen.size > dedupeSize) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    return false;
  }

  async function acquireSlot() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(() => resolve(undefined)));
  }

  function releaseSlot() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  /** @param {MaxUpdate} update */
  async function run(update) {
    await acquireSlot();
    try {
      await handle(update);
    } catch (error) {
      logger.error("update_failed", { updateType: update?.update_type, ...errorFields(error) });
    } finally {
      releaseSlot();
    }
  }

  return {
    /**
     * Queues an update. Resolves when it has been handled (false for duplicates).
     * @param {MaxUpdate} update
     * @returns {Promise<boolean>}
     */
    push(update) {
      if (!update || typeof update !== "object" || typeof update.update_type !== "string") {
        logger.warn("update_invalid");
        return Promise.resolve(false);
      }
      const key = updateKey(update);
      if (isDuplicate(key)) {
        logger.info("update_duplicate", { updateType: update.update_type });
        return Promise.resolve(false);
      }
      const userId = userOf(update)?.user_id;
      const chainKey = userId !== undefined ? `user:${userId}` : key;
      pending += 1;
      const task = (chains.get(chainKey) ?? Promise.resolve()).then(() => run(update));
      chains.set(chainKey, task);
      return task.then(() => {
        if (chains.get(chainKey) === task) chains.delete(chainKey);
        pending -= 1;
        if (!pending) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const resolve of waiters) resolve();
        }
        return true;
      });
    },

    /** Number of queued or running updates. */
    get pending() {
      return pending;
    },

    /**
     * Waits until the queue is empty (or the timeout passes).
     * @param {number} [timeoutMs]
     */
    async drain(timeoutMs = 10_000) {
      if (!pending) return true;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const idle = new Promise((resolve) => idleWaiters.push(() => resolve(true)));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const result = await Promise.race([idle, timeout]);
      clearTimeout(timer);
      return /** @type {boolean} */ (result);
    },
  };
}

/** @typedef {ReturnType<typeof createProcessor>} Processor */
