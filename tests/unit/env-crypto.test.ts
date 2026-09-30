import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hmacSha256, randomToken, sha256Hex, timingSafeEqual, toHex } from "@/lib/server/crypto";
import { features, getEnv, type MediaBucket } from "@/lib/server/env";

describe("crypto helpers", () => {
  it("sha256Hex matches the known vector and node:crypto", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("Олимпус")).toBe(createHash("sha256").update("Олимпус").digest("hex"));
  });

  it("hmacSha256 matches node:crypto for string and byte keys", async () => {
    const expected = createHmac("sha256", "key").update("data").digest("hex");
    expect(toHex(await hmacSha256("key", "data"))).toBe(expected);
    expect(toHex(await hmacSha256(new TextEncoder().encode("key"), "data"))).toBe(expected);
  });

  it("timingSafeEqual compares values of any length", async () => {
    expect(await timingSafeEqual("secret", "secret")).toBe(true);
    expect(await timingSafeEqual("secret", "secreT")).toBe(false);
    expect(await timingSafeEqual("secret", "secret-longer")).toBe(false);
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  it("randomToken returns 64 unique hex characters", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("toHex pads bytes", () => {
    expect(toHex(Uint8Array.from([0, 15, 255]))).toBe("000fff");
  });
});

describe("getEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("reads trimmed strings from the worker vars and falls back to process.env", () => {
    process.env.RUNNER_URL = "http://runner:8080";
    process.env.BOT_TOKEN = "from-process";
    const env = getEnv({ BOT_TOKEN: "  bot-token \n", ADMIN_PASSWORD: 12345, RUNNER_TOKEN: null });
    expect(env.BOT_TOKEN).toBe("bot-token");
    expect(env.ADMIN_PASSWORD).toBe("12345");
    expect(env.RUNNER_URL).toBe("http://runner:8080");
    expect(env.BUCKET).toBeNull();
  });

  it("keeps an explicitly empty worker var instead of the process fallback", () => {
    process.env.BOT_TOKEN = "from-process";
    expect(getEnv({ BOT_TOKEN: "" }).BOT_TOKEN).toBe("");
  });

  it("returns '' for unset values", () => {
    delete process.env.BOT_REMINDERS;
    expect(getEnv({}).BOT_REMINDERS).toBe("");
  });

  it("accepts only bucket-like bindings", () => {
    const bucket: MediaBucket = {
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
    };
    expect(getEnv({ BUCKET: bucket }).BUCKET).toBe(bucket);
    expect(getEnv({ BUCKET: "olympus-media" }).BUCKET).toBeNull();
    expect(getEnv({ BUCKET: { put: 1 } }).BUCKET).toBeNull();
  });
});

describe("features", () => {
  const env = (values: Record<string, string>) => ({
    ...getEnv({}),
    BOT_TOKEN: "",
    RUNNER_URL: "",
    BOT_REMINDERS: "",
    MAX_BOT_NAME: "",
    ...values,
  });

  it.each([
    [{}, { runner: false, max: false, reminders: false, botName: null }],
    [
      { RUNNER_URL: "http://runner" },
      { runner: true, max: false, reminders: false, botName: null },
    ],
    // Reminders are opt-in (same switch as the chat-bot): off unless BOT_REMINDERS=on.
    [{ BOT_TOKEN: "t" }, { runner: false, max: true, reminders: false, botName: null }],
    [
      { BOT_TOKEN: "t", BOT_REMINDERS: "OFF" },
      { runner: false, max: true, reminders: false, botName: null },
    ],
    [
      { BOT_TOKEN: "t", BOT_REMINDERS: "maybe" },
      { runner: false, max: true, reminders: false, botName: null },
    ],
    [
      { BOT_TOKEN: "t", BOT_REMINDERS: "on" },
      { runner: false, max: true, reminders: true, botName: null },
    ],
    [
      { BOT_TOKEN: "t", BOT_REMINDERS: " True " },
      { runner: false, max: true, reminders: true, botName: null },
    ],
    [{ BOT_REMINDERS: "on" }, { runner: false, max: false, reminders: false, botName: null }],
    // The bot name goes into «Открыть в MAX» links: only a plain MAX nickname is passed on.
    [
      { MAX_BOT_NAME: "id1234567890_bot" },
      { runner: false, max: false, reminders: false, botName: "id1234567890_bot" },
    ],
    [
      { MAX_BOT_NAME: "evil/../bot?x=1" },
      { runner: false, max: false, reminders: false, botName: null },
    ],
  ])("%j → %j", (values, expected) => {
    expect(features(env(values))).toEqual(expected);
  });
});
