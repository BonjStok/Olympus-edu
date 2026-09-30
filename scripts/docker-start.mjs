import fs from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { withWorkerVars } from "./lib/worker-vars.mjs";

process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
process.env.WRANGLER_SEND_METRICS = "false";
process.env.WRANGLER_WRITE_LOGS = "false";

const appEnv = String(process.env.OLYMPUS_ENV || "development").toLowerCase();
if (!["development", "production"].includes(appEnv))
  throw new Error("OLYMPUS_ENV must be development or production");

const databaseConfigured = Boolean(
  process.env.DATABASE_URL || (process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME),
);
if (!databaseConfigured)
  throw new Error(
    "PostgreSQL is not configured: set DATABASE_URL or DB_HOST/DB_USER/DB_NAME/DB_PASSWORD",
  );

if (appEnv === "production") {
  const required = ["ADMIN_PASSWORD", "BOT_TOKEN", "TEST_API_PASSWORD", "DB_PASSWORD"];
  const missing = required.filter((name) => !String(process.env[name] || "").trim());
  if (missing.length)
    throw new Error(`Missing production environment variables: ${missing.join(", ")}`);
  if (String(process.env.ADMIN_PASSWORD).length < 12)
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters in production");
  if (String(process.env.TEST_API_PASSWORD).length < 12)
    throw new Error("TEST_API_PASSWORD must contain at least 12 characters in production");
  if (String(process.env.DB_PASSWORD).length < 16)
    throw new Error("DB_PASSWORD must contain at least 16 characters in production");
  if (String(process.env.DB_PASSWORD) === "olympus_local_dev")
    throw new Error("Replace the local PostgreSQL password before production");
  // .env.example ships working passwords for local checks; they must never reach production.
  if (process.env.ADMIN_PASSWORD === "olympus-local-admin")
    throw new Error("Replace the local ADMIN_PASSWORD from .env.example before production");
  if (process.env.TEST_API_PASSWORD === "olympus-local-test")
    throw new Error("Replace the local TEST_API_PASSWORD from .env.example before production");
}
if (appEnv === "production" && process.env.RUNNER_URL && !process.env.RUNNER_TOKEN)
  throw new Error("RUNNER_TOKEN is required when RUNNER_URL is set in production");

// Database preparation happens once per container start, never on the request path:
// migrations, then content seeding (SEED_MODE) and removal of expired sessions.
for (const script of ["scripts/postgres-migrate.mjs", "scripts/seed.mjs"]) {
  const step = spawnSync("node", [script], { stdio: "inherit", env: process.env });
  if (step.status !== 0) process.exit(step.status ?? 1);
}

// Plain settings become wrangler vars; secrets are read by wrangler from the environment and are
// never printed (see scripts/lib/worker-vars.mjs).
const config = "dist/server/wrangler.json";
fs.writeFileSync(
  config,
  JSON.stringify(withWorkerVars(JSON.parse(fs.readFileSync(config, "utf8")), process.env)),
);

const proc = spawn(
  "node",
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    config,
    "--local",
    "--persist-to",
    ".wrangler/state",
    "--ip",
    process.env.OLYMPUS_HOST || "0.0.0.0",
    "--port",
    process.env.PORT || "3000",
    "--inspector-port",
    "0",
  ],
  { stdio: "inherit" },
);
// Expired sessions are also removed periodically while the container runs.
const cleanup = setInterval(
  () => {
    spawn("node", ["scripts/seed.mjs", "--cleanup-only"], { stdio: "inherit", env: process.env });
  },
  6 * 60 * 60 * 1000,
);
cleanup.unref();

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => proc.kill(sig));
proc.on("exit", (code) => process.exit(code ?? 0));
