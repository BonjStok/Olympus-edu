// Configuration handed from the container environment to the Worker (wrangler dev in Docker).
//
// Plain values go to `vars` of the generated wrangler.json. Secrets must not: wrangler prints every
// plain var with its value when it starts, i.e. into `docker logs`. Secrets are listed in
// `secrets.required` instead; wrangler then reads them from the process environment and shows them
// as "(hidden)".

/** Non-secret settings of the web app. */
export const PLAIN_VARS = [
  "BOT_REMINDERS",
  "MAX_BOT_NAME",
  "TEST_API_USERNAME",
  "RUNNER_URL",
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_NAME",
  "DB_SSL",
];

/** Secrets: passwords, tokens and connection strings that may contain a password. */
export const SECRET_VARS = [
  "ADMIN_PASSWORD",
  "BOT_TOKEN",
  "TEST_API_PASSWORD",
  "RUNNER_TOKEN",
  "DATABASE_URL",
  "DB_PASSWORD",
];

/**
 * Adds the app configuration to a generated wrangler config. Unset secrets are left out (the app
 * treats a missing binding as ""), so wrangler does not warn about them.
 * @param {Record<string, unknown>} config parsed dist/server/wrangler.json
 * @param {Record<string, string | undefined>} env usually process.env
 * @returns {Record<string, unknown> & { vars: Record<string, string>; secrets?: { required: string[] } }}
 */
export function withWorkerVars(config, env) {
  const vars = Object.fromEntries(PLAIN_VARS.map((key) => [key, env[key] || ""]));
  const required = SECRET_VARS.filter((key) => Boolean(env[key]));
  const next = { ...config, vars };
  if (required.length) next.secrets = { required };
  else delete next.secrets;
  return next;
}
