// @ts-check
/**
 * Entry point of the `bot` container: `node bot/server.mjs`.
 * Without BOT_TOKEN the service stays up in `disabled` mode and only serves /health,
 * so `docker compose up` works without secrets.
 */

import { startBot } from "./app.mjs";
import { createLogger, errorFields } from "./log.mjs";

const fallbackLogger = createLogger({ base: { service: "bot" }, secrets: [process.env.BOT_TOKEN] });

/** @type {import("./app.mjs").BotService} */
let bot;
try {
  bot = await startBot();
} catch (error) {
  fallbackLogger.error("bot_start_failed", errorFields(error));
  process.exit(1);
}

let stopping = false;
/** @param {string} signal */
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  bot.logger.info("bot_stopping", { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await bot.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) =>
  bot.logger.error("unhandled_rejection", errorFields(error)),
);
process.on("uncaughtException", (error) => {
  bot.logger.error("uncaught_exception", errorFields(error));
  process.exit(1);
});
