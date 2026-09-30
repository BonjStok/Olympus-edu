import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// Type-only imports pull the entry points into `pnpm typecheck` (they are `// @ts-check`
// JavaScript) without running them.
import type * as _server from "@/bot/server.mjs";
import type * as _smoke from "@/bot/scripts/smoke.mjs";

describe("entry points", () => {
  it.each(["bot/server.mjs", "bot/scripts/smoke.mjs"])(
    "%s is valid JavaScript for Node",
    (file) => {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );

  it("smoke script refuses to run without a token and never calls the API", () => {
    const result = spawnSync(process.execPath, ["bot/scripts/smoke.mjs"], {
      encoding: "utf8",
      env: { ...process.env, BOT_TOKEN: "", MAX_API_URL: "http://127.0.0.1:9" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Set BOT_TOKEN");
  });
});
