// @ts-check
/**
 * Structured JSON logs (one line per event) without secrets or message texts.
 * Allowed identifiers: MAX user ids, update types, command names, HTTP statuses.
 */

const LEVELS = /** @type {const} */ ({ debug: 10, info: 20, warn: 30, error: 40 });
const REDACTED_KEYS = new Set([
  "token",
  "authorization",
  "secret",
  "password",
  "text",
  "body",
  "first_name",
  "name",
]);

/**
 * @typedef {keyof typeof LEVELS} Level
 * @typedef {{
 *   debug(msg: string, fields?: Record<string, unknown>): void,
 *   info(msg: string, fields?: Record<string, unknown>): void,
 *   warn(msg: string, fields?: Record<string, unknown>): void,
 *   error(msg: string, fields?: Record<string, unknown>): void,
 *   child(fields: Record<string, unknown>): Logger,
 * }} Logger
 */

/**
 * @param {unknown} error
 */
export function errorFields(error) {
  if (!(error instanceof Error)) return { error: String(error) };
  const e = /** @type {Error & { status?: number, code?: string, kind?: string }} */ (error);
  return {
    error: e.message,
    errorName: e.name,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.code ? { code: e.code } : {}),
    ...(e.kind ? { kind: e.kind } : {}),
  };
}

/**
 * @param {{
 *   level?: string,
 *   write?: (line: string) => void,
 *   secrets?: (string | undefined)[],
 *   base?: Record<string, unknown>,
 *   now?: () => number,
 * }} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[/** @type {Level} */ (options.level)] ?? LEVELS.info;
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  const secrets = (options.secrets ?? []).filter(
    /** @returns {s is string} */ (s) => typeof s === "string" && s.length >= 6,
  );
  const now = options.now ?? Date.now;

  /**
   * @param {Record<string, unknown>} base
   * @returns {Logger}
   */
  function make(base) {
    /**
     * @param {Level} level
     * @param {string} msg
     * @param {Record<string, unknown>} [fields]
     */
    function log(level, msg, fields) {
      if (LEVELS[level] < threshold) return;
      /** @type {Record<string, unknown>} */
      const entry = { time: new Date(now()).toISOString(), level, msg, ...base };
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === undefined) continue;
        entry[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : value;
      }
      let line;
      try {
        line = JSON.stringify(entry);
      } catch {
        line = JSON.stringify({ time: entry.time, level, msg, note: "unserializable fields" });
      }
      for (const secret of secrets) line = line.split(secret).join("[redacted]");
      write(line);
    }
    return {
      debug: (msg, fields) => log("debug", msg, fields),
      info: (msg, fields) => log("info", msg, fields),
      warn: (msg, fields) => log("warn", msg, fields),
      error: (msg, fields) => log("error", msg, fields),
      child: (fields) => make({ ...base, ...fields }),
    };
  }

  return make(options.base ?? {});
}

/** A logger that drops everything (tests, scripts). */
export const silentLogger = createLogger({ write: () => {} });
