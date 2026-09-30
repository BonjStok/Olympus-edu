// @ts-check
/**
 * Outgoing request pacing for the Bot API.
 *
 * Platform limits (docs): 30 requests/s per bot, 2 messages/s per chat (also for
 * POST /answers). The bot stays below them: a global spacing of 1000/rps ms and a
 * per-chat spacing (1 s by default). Slots are reserved in call order, so
 * concurrent callers are served first-come, first-served.
 */

/**
 * @param {number} ms
 */
export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {{ acquire(chatKey?: string): Promise<void> }} RateLimiter
 */

/**
 * @param {{
 *   rps?: number,
 *   chatIntervalMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {RateLimiter}
 */
export function createRateLimiter(options = {}) {
  const rps = Math.max(1, Math.min(30, options.rps ?? 25));
  const globalInterval = 1000 / rps;
  const chatInterval = Math.max(0, options.chatIntervalMs ?? 1000);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  let nextGlobal = 0;
  /** @type {Map<string, number>} */
  const nextByChat = new Map();

  function prune() {
    if (nextByChat.size < 10_000) return;
    const t = now();
    for (const [key, at] of nextByChat) if (at <= t) nextByChat.delete(key);
  }

  return {
    async acquire(chatKey) {
      if (chatKey && chatInterval > 0) {
        prune();
        const t = now();
        const at = Math.max(t, nextByChat.get(chatKey) ?? 0);
        nextByChat.set(chatKey, at + chatInterval);
        if (at > t) await sleep(at - t);
      }
      // The global slot is reserved only when the chat slot is due, so a chat that
      // has to wait never delays requests for other chats.
      const t = now();
      const at = Math.max(t, nextGlobal);
      nextGlobal = at + globalInterval;
      if (at > t) await sleep(at - t);
    },
  };
}

/** No pacing (tests). */
export const noLimit = /** @type {RateLimiter} */ ({ acquire: async () => {} });
