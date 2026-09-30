// Verification of MAX mini-app launch data (`window.WebApp.initData`).
// Algorithm: https://dev.max.ru/docs/webapps/validation
//   1. split `key=value` pairs, every key must appear once, `hash` exactly once;
//   2. URL-decode the values, drop `hash`, sort pairs by key, join as `key=value` with "\n";
//   3. secret_key = HMAC_SHA256(key = "WebAppData", message = BOT_TOKEN);
//   4. hex(HMAC_SHA256(key = secret_key, message = launch_params)) must equal `hash`.
// `auth_date` is Unix time in seconds; the docs recommend accepting data for one hour.
import { ApiError } from "./errors";
import { hmacSha256, timingSafeEqual, toHex } from "./crypto";

export const INIT_DATA_MAX_AGE_SECONDS = 3600;
/** Tolerated clock difference between MAX and this server for `auth_date` in the future. */
export const INIT_DATA_CLOCK_SKEW_SECONDS = 30;
export const INIT_DATA_MAX_LENGTH = 8192;
export const START_PARAM_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export interface MaxUser {
  /** int64 user id kept as a decimal string (never goes through `Number`). */
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
  /** `first_name` + `last_name`, trimmed; "" when MAX sent neither. */
  displayName: string;
}

export interface VerifiedInitData {
  user: MaxUser;
  authDate: number;
  /** Signed deep-link payload (`start_param`), when present and well-formed. */
  startParam: string | null;
}

// All failures share the code MAX_AUTH_FAILED (the client offers to reopen the app); the status and
// the message tell them apart.
const malformed = () =>
  new ApiError(400, "MAX_AUTH_FAILED", "Неверные данные запуска MAX. Открой приложение заново");
const invalidSignature = () =>
  new ApiError(401, "MAX_AUTH_FAILED", "Подпись MAX не прошла проверку. Открой приложение заново");
const expired = () =>
  new ApiError(
    401,
    "MAX_AUTH_FAILED",
    "Данные запуска устарели. Открой приложение заново через MAX",
  );

type Pair = [key: string, value: string];

function splitPairs(initData: string): Pair[] {
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const part of initData.split("&")) {
    const index = part.indexOf("=");
    if (index <= 0) throw malformed();
    const key = part.slice(0, index);
    if (seen.has(key)) throw malformed();
    seen.add(key);
    pairs.push([key, part.slice(index + 1)]);
  }
  if (!seen.has("hash")) throw malformed();
  return pairs;
}

function decodeValues(pairs: Pair[], plusAsSpace: boolean): Pair[] {
  try {
    return pairs.map(([key, value]) => [
      key,
      decodeURIComponent(plusAsSpace ? value.replace(/\+/g, " ") : value),
    ]);
  } catch {
    throw malformed();
  }
}

export function launchParams(pairs: readonly Pair[]): string {
  return pairs
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function signLaunchParams(params: string, botToken: string): Promise<string> {
  const secret = await hmacSha256("WebAppData", botToken);
  return toHex(await hmacSha256(secret, params));
}

type Reviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

/** Parses the `user` JSON keeping the int64 `id` exactly as written. */
function parseUser(json: string): Record<string, unknown> {
  const reviver: Reviver = (key, value, context) =>
    key === "id" && typeof value === "number" && context?.source ? context.source : value;
  let parsed: unknown;
  try {
    parsed = (JSON.parse as (text: string, reviver: Reviver) => unknown)(json, reviver);
  } catch {
    throw malformed();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformed();
  return parsed as Record<string, unknown>;
}

function userId(value: unknown): string {
  const id =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : String(value ?? "");
  if (!/^[1-9]\d{0,19}$/.test(id)) throw malformed();
  return id;
}

function text(value: unknown, max = 100): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Verifies `initData` with the bot token and returns the signed user. Throws `ApiError`
 * `MAX_AUTH_FAILED`: 400 (malformed), 401 (signature) or 401 (older than an hour).
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  nowMs: number = Date.now(),
): Promise<VerifiedInitData> {
  if (!initData || initData.length > INIT_DATA_MAX_LENGTH) throw malformed();
  const raw = splitPairs(initData);
  const hash = raw.find(([key]) => key === "hash")![1].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw invalidSignature();

  // The official TypeScript sample decodes with decodeURIComponent ("+" stays "+"); the Python,
  // Go and Java samples decode "+" as a space. Accept a signature that matches either reading.
  const variants = [decodeValues(raw, false)];
  if (initData.includes("+")) variants.push(decodeValues(raw, true));
  let verified: Pair[] | null = null;
  for (const pairs of variants) {
    if (await timingSafeEqual(await signLaunchParams(launchParams(pairs), botToken), hash)) {
      verified = pairs;
      break;
    }
  }
  if (!verified) throw invalidSignature();

  const fields = new Map(verified);
  const authDateText = fields.get("auth_date") ?? "";
  if (!/^\d{1,12}$/.test(authDateText)) throw invalidSignature();
  const authDate = Number(authDateText);
  const age = nowMs / 1000 - authDate;
  if (age > INIT_DATA_MAX_AGE_SECONDS || age < -INIT_DATA_CLOCK_SKEW_SECONDS) throw expired();

  const userJson = fields.get("user");
  if (!userJson) throw malformed();
  const user = parseUser(userJson);
  const firstName = text(user.first_name);
  const lastName = text(user.last_name);
  const startParam = fields.get("start_param") ?? "";
  return {
    user: {
      id: userId(user.id),
      firstName,
      lastName,
      username: text(user.username) || null,
      displayName: [firstName, lastName].filter(Boolean).join(" "),
    },
    authDate,
    startParam: START_PARAM_PATTERN.test(startParam) ? startParam : null,
  };
}
