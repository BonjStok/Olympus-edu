import { describe, expect, it } from "vitest";
import { PLAIN_VARS, SECRET_VARS, withWorkerVars } from "../../scripts/lib/worker-vars.mjs";

describe("worker configuration for Docker", () => {
  const env = {
    ADMIN_PASSWORD: "admin-VALUE",
    BOT_TOKEN: "bot-VALUE",
    TEST_API_PASSWORD: "test-VALUE",
    RUNNER_TOKEN: "runner-VALUE",
    DB_PASSWORD: "db-VALUE",
    DATABASE_URL: "",
    RUNNER_URL: "http://runner:8080",
    DB_HOST: "postgres",
    BOT_REMINDERS: "off",
    PATH: "/usr/bin",
  };

  it("never puts a secret into the printed vars", () => {
    const config = withWorkerVars({ name: "olympus", vars: { OLD: "x" } }, env);
    expect(config.name).toBe("olympus");
    expect(Object.keys(config.vars)).toEqual(PLAIN_VARS);
    expect(config.vars).toMatchObject({ RUNNER_URL: "http://runner:8080", DB_PORT: "" });
    expect(JSON.stringify(config.vars)).not.toMatch(/-VALUE/);
    // Secrets are declared by name only; wrangler reads the values from the environment.
    expect(config.secrets).toEqual({
      required: ["ADMIN_PASSWORD", "BOT_TOKEN", "TEST_API_PASSWORD", "RUNNER_TOKEN", "DB_PASSWORD"],
    });
    expect(JSON.stringify(config)).not.toMatch(/-VALUE/);
  });

  it("covers every setting of the app exactly once", () => {
    const all = [...PLAIN_VARS, ...SECRET_VARS];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(
      expect.arrayContaining(["ADMIN_PASSWORD", "BOT_TOKEN", "BOT_REMINDERS", "DATABASE_URL"]),
    );
  });

  it("omits the secrets block when no secret is set", () => {
    const config = withWorkerVars({ secrets: { required: ["X"] } }, { DB_HOST: "db" });
    expect(config).not.toHaveProperty("secrets");
  });
});
