/**
 * `.env.example` is the only configuration an evaluator gets: `cp .env.example .env` must yield
 * a working local stack. Guard against duplicated keys (the last one silently wins) and against
 * server settings that are read by the app but not documented there.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const keys = example
  .split("\n")
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
  .filter((key): key is string => Boolean(key));

// Set by compose from POSTGRES_* (see compose.yaml), not by the user.
const COMPOSE_PROVIDED = new Set(["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"]);

describe(".env.example", () => {
  it("declares every key once", () => {
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(duplicates).toEqual([]);
  });

  it("documents every setting the server reads", () => {
    const source = fs.readFileSync(path.join(ROOT, "lib/server/env.ts"), "utf8");
    const list = /const TEXT_KEYS = \[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
    const serverKeys = [...list.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
    expect(serverKeys.length).toBeGreaterThan(5);
    const missing = serverKeys.filter((key) => !COMPOSE_PROVIDED.has(key) && !keys.includes(key));
    expect(missing).toEqual([]);
  });

  it("ships local-only passwords that production refuses", () => {
    const start = fs.readFileSync(path.join(ROOT, "scripts/docker-start.mjs"), "utf8");
    for (const key of ["ADMIN_PASSWORD", "TEST_API_PASSWORD"]) {
      const value = new RegExp(`^${key}=(.*)$`, "m").exec(example)?.[1] ?? "";
      expect(value, key).not.toBe("");
      expect(start, `${key} guard`).toContain(`"${value}"`);
    }
  });
});
