import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/server/errors";
import {
  INIT_DATA_CLOCK_SKEW_SECONDS,
  INIT_DATA_MAX_AGE_SECONDS,
  INIT_DATA_MAX_LENGTH,
  launchParams,
  signLaunchParams,
  verifyInitData,
} from "@/lib/server/max-auth";

const BOT_TOKEN = "123456:bot-token-for-tests";
const NOW_MS = 1_790_000_000_000;
const NOW = NOW_MS / 1000;

type Field = [string, string];

/**
 * Independent reference of https://dev.max.ru/docs/webapps/validation:
 * secret = HMAC_SHA256(key = "WebAppData", msg = BOT_TOKEN);
 * hash = hex(HMAC_SHA256(key = secret, msg = sorted "key=value" lines without hash)).
 */
function referenceHash(fields: Field[], botToken = BOT_TOKEN): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const check = fields
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return createHmac("sha256", secret).update(check).digest("hex");
}

const defaultUser = JSON.stringify({
  id: 400_500_600,
  first_name: "Маша",
  last_name: "Иванова",
  username: "masha",
  language_code: "ru",
});

function fields(extra: Record<string, string> = {}, authDate = NOW): Field[] {
  return Object.entries({
    auth_date: String(authDate),
    query_id: "AAH_query-1",
    user: defaultUser,
    ...extra,
  });
}

/** URL-encodes the pairs (like `window.WebApp.initData`) and appends the hash. */
function initData(pairs: Field[], hash = referenceHash(pairs)): string {
  return [...pairs, ["hash", hash] as Field]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

async function rejection(data: string, botToken = BOT_TOKEN, now = NOW_MS): Promise<ApiError> {
  try {
    await verifyInitData(data, botToken, now);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected verifyInitData to fail");
}

describe("signature algorithm", () => {
  it("builds the check string from sorted pairs without hash", () => {
    expect(
      launchParams([
        ["user", '{"id":1}'],
        ["hash", "ignored"],
        ["auth_date", "1"],
        ["chat", "c"],
      ]),
    ).toBe('auth_date=1\nchat=c\nuser={"id":1}');
  });

  it("sorts keys by code units, not by locale", () => {
    // "aB" < "a_b" in code units, but a locale-aware sort puts "a_b" first.
    expect(
      launchParams([
        ["a_b", "1"],
        ["aB", "2"],
      ]),
    ).toBe("aB=2\na_b=1");
  });

  it("derives the key as HMAC(key = 'WebAppData', message = bot token)", async () => {
    const check = launchParams(fields());
    expect(await signLaunchParams(check, BOT_TOKEN)).toBe(referenceHash(fields()));
  });
});

describe("verifyInitData", () => {
  it("accepts data signed by MAX and returns the user", async () => {
    const result = await verifyInitData(initData(fields()), BOT_TOKEN, NOW_MS);
    expect(result).toEqual({
      user: {
        id: "400500600",
        firstName: "Маша",
        lastName: "Иванова",
        username: "masha",
        displayName: "Маша Иванова",
      },
      authDate: NOW,
      startParam: null,
    });
  });

  it("keeps a 64-bit user id exactly and accepts ids sent as strings", async () => {
    const big = fields({ user: '{"id":9223372036854775807,"first_name":"Big"}' });
    expect((await verifyInitData(initData(big), BOT_TOKEN, NOW_MS)).user).toMatchObject({
      id: "9223372036854775807",
      displayName: "Big",
      username: null,
      lastName: "",
    });
    const text = fields({ user: '{"id":"777","last_name":" Петров "}' });
    expect((await verifyInitData(initData(text), BOT_TOKEN, NOW_MS)).user).toMatchObject({
      id: "777",
      displayName: "Петров",
    });
  });

  it("verifies extra signed fields (chat, ip) and returns a valid start_param", async () => {
    const data = initData(
      fields({
        chat: '{"id":12345,"type":"DIALOG"}',
        ip: "192.168.0.1",
        start_param: "mock_mock-4-math",
      }),
    );
    expect((await verifyInitData(data, BOT_TOKEN, NOW_MS)).startParam).toBe("mock_mock-4-math");
  });

  it("ignores a malformed start_param but still signs it", async () => {
    const data = initData(fields({ start_param: "bad param!" }));
    expect((await verifyInitData(data, BOT_TOKEN, NOW_MS)).startParam).toBeNull();
  });

  it("accepts an upper-case hash", async () => {
    const pairs = fields();
    const data = initData(pairs, referenceHash(pairs).toUpperCase());
    expect((await verifyInitData(data, BOT_TOKEN, NOW_MS)).user.id).toBe("400500600");
  });

  it("accepts '+' as a literal plus (decodeURIComponent reading)", async () => {
    const pairs = fields({ user: '{"id":5,"first_name":"C++"}' });
    const hash = referenceHash(pairs);
    const data = `auth_date=${NOW}&query_id=AAH_query-1&user=${encodeURIComponent(
      '{"id":5,"first_name":"C',
    )}++${encodeURIComponent('"}')}&hash=${hash}`;
    expect((await verifyInitData(data, BOT_TOKEN, NOW_MS)).user.firstName).toBe("C++");
  });

  it("accepts '+' as a space (form-encoding reading)", async () => {
    const pairs = fields({ user: '{"id":6,"first_name":"Анна Мария"}' });
    const data = new URLSearchParams([...pairs, ["hash", referenceHash(pairs)]]).toString();
    expect(data).toContain("+");
    expect((await verifyInitData(data, BOT_TOKEN, NOW_MS)).user.firstName).toBe("Анна Мария");
  });

  it.each([
    ["a tampered user", (data: string) => data.replace("400500600", "400500601")],
    [
      "a tampered auth_date",
      (data: string) => data.replace(`auth_date=${NOW}`, `auth_date=${NOW + 1}`),
    ],
    ["a removed field", (data: string) => data.replace(/&query_id=[^&]*/, "")],
    ["an added field", (data: string) => `${data}&extra=1`],
    ["a non-hex hash", (data: string) => data.replace(/hash=[0-9a-f]+/, "hash=zz")],
    ["a truncated hash", (data: string) => data.replace(/(hash=[0-9a-f]{10})[0-9a-f]+/, "$1")],
  ])("rejects %s with 401 MAX_AUTH_FAILED (signature)", async (_name, tamper) => {
    const error = await rejection(tamper(initData(fields())));
    expect(error).toMatchObject({ status: 401, code: "MAX_AUTH_FAILED" });
  });

  it("rejects data signed for another bot", async () => {
    expect(await rejection(initData(fields()), "999:other-bot")).toMatchObject({
      status: 401,
      code: "MAX_AUTH_FAILED",
    });
  });

  it.each([
    ["empty data", ""],
    ["no hash", `auth_date=${NOW}&user=%7B%7D`],
    ["a duplicated key", `auth_date=${NOW}&auth_date=${NOW}&hash=${"0".repeat(64)}`],
    ["a duplicated hash", `hash=${"0".repeat(64)}&hash=${"0".repeat(64)}`],
    ["a pair without '='", `auth_date&hash=${"0".repeat(64)}`],
    ["an empty key", `=1&hash=${"0".repeat(64)}`],
    ["too much data", `user=${"a".repeat(INIT_DATA_MAX_LENGTH)}&hash=${"0".repeat(64)}`],
  ])("rejects %s with 400 MAX_AUTH_FAILED (malformed)", async (_name, data) => {
    expect(await rejection(data)).toMatchObject({ status: 400, code: "MAX_AUTH_FAILED" });
  });

  it("rejects broken percent-encoding with 400", async () => {
    const data = `auth_date=${NOW}&user=%E0%A4%A&hash=${"0".repeat(64)}`;
    expect(await rejection(data)).toMatchObject({ status: 400, code: "MAX_AUTH_FAILED" });
  });

  it("enforces the one-hour lifetime and a small clock skew", async () => {
    const at = (authDate: number) => initData(fields({}, authDate));
    await expect(
      verifyInitData(at(NOW - INIT_DATA_MAX_AGE_SECONDS), BOT_TOKEN, NOW_MS),
    ).resolves.toBeTruthy();
    await expect(
      verifyInitData(at(NOW + INIT_DATA_CLOCK_SKEW_SECONDS), BOT_TOKEN, NOW_MS),
    ).resolves.toBeTruthy();
    for (const authDate of [
      NOW - INIT_DATA_MAX_AGE_SECONDS - 1,
      NOW + INIT_DATA_CLOCK_SKEW_SECONDS + 1,
    ])
      expect(await rejection(at(authDate))).toMatchObject({
        status: 401,
        code: "MAX_AUTH_FAILED",
      });
  });

  it.each([
    ["without auth_date", fields().filter(([key]) => key !== "auth_date")],
    ["with a non-numeric auth_date", fields({ auth_date: "yesterday" })],
  ])("rejects signed data %s as invalid", async (_name, pairs) => {
    expect(await rejection(initData(pairs))).toMatchObject({
      status: 401,
      code: "MAX_AUTH_FAILED",
    });
  });

  it.each([
    ["no user", fields().filter(([key]) => key !== "user")],
    ["user that is not JSON", fields({ user: "{id:1" })],
    ["user that is an array", fields({ user: "[1]" })],
    ["user without id", fields({ user: '{"first_name":"A"}' })],
    ["user id 0", fields({ user: '{"id":0}' })],
    ["negative user id", fields({ user: '{"id":-5}' })],
    ["fractional user id", fields({ user: '{"id":1.5}' })],
    ["user id with letters", fields({ user: '{"id":"12a"}' })],
  ])("rejects correctly signed data with %s as malformed", async (_name, pairs) => {
    expect(await rejection(initData(pairs))).toMatchObject({
      status: 400,
      code: "MAX_AUTH_FAILED",
    });
  });

  it("trims and bounds names", async () => {
    const long = "Я".repeat(150);
    const pairs = fields({
      user: JSON.stringify({ id: 1, first_name: `  ${long}  `, username: 7 }),
    });
    const { user } = await verifyInitData(initData(pairs), BOT_TOKEN, NOW_MS);
    expect(user.firstName).toHaveLength(100);
    expect(user.username).toBeNull();
  });
});
