// @ts-check
/**
 * Manual smoke check with the real MAX token (see docs/BOT.md, «Проверка с настоящим токеном»).
 *
 *   BOT_TOKEN=… node bot/scripts/smoke.mjs                 # read-only: GET /me, GET /subscriptions
 *   BOT_TOKEN=… node bot/scripts/smoke.mjs --send-to=<id>  # + sends the greeting to a MAX user id
 *   … --register-commands   PATCH /me/commands
 *   … --resubscribe         POST /subscriptions with BOT_WEBHOOK_URL / BOT_WEBHOOK_SECRET
 *   … --unsubscribe         DELETE /subscriptions?url=BOT_WEBHOOK_URL (lets long polling work)
 *
 * The token is never printed.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMaxApi, DEFAULT_API_URL } from "../api.mjs";
import { UPDATE_TYPES, WEBHOOK_SECRET } from "../config.mjs";
import { COMMANDS } from "../router.mjs";
import { greetingScreen } from "../screens.mjs";
import { moscowToday } from "../time.mjs";

const CA = fileURLToPath(new URL("../certs/russian_trusted_root_ca.crt", import.meta.url));

// platform-api2.max.ru needs the Минцифры root CA; Node reads it only at start-up.
if (!process.env.NODE_EXTRA_CA_CERTS && existsSync(CA)) {
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CA },
  });
  process.exit(child.status ?? 1);
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);
const env = process.env;
const token = String(env.BOT_TOKEN || "").trim();
const baseUrl = String(env.MAX_API_URL || DEFAULT_API_URL).trim();

/** @param {string} title @param {unknown} [value] */
const line = (title, value = "") => console.log(`${title.padEnd(28)} ${value}`);
/** @param {string} title */
const section = (title) => console.log(`\n== ${title}`);

if (!token) {
  console.error("Set BOT_TOKEN (the token from business.max.ru → Чат-боты → Настройки).");
  process.exit(2);
}

const api = createMaxApi({ token, baseUrl, retries: 1 });
let failures = 0;

/**
 * @template T
 * @param {string} title
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
async function step(title, fn) {
  try {
    return await fn();
  } catch (error) {
    failures += 1;
    const e = /** @type {any} */ (error);
    line(`✗ ${title}`, `${e?.status ?? ""} ${e?.code ?? ""} ${e?.message ?? e}`.trim());
    if (String(e?.message).includes("UNABLE_TO_GET_ISSUER_CERT"))
      line("", `TLS: run with NODE_EXTRA_CA_CERTS=${CA}`);
    return undefined;
  }
}

section("Bot API");
line("API", baseUrl);
line("NODE_EXTRA_CA_CERTS", env.NODE_EXTRA_CA_CERTS || "(not set)");

const me = await step("GET /me", () => api.getMe());
if (me) {
  line("✓ GET /me", "token accepted");
  line("bot user_id (contact_id)", me.user_id);
  line("name", me.first_name || me.name || "");
  line("username (web_app)", me.username || "(empty – set MAX_BOT_NAME)");
  if (env.MAX_BOT_NAME && me.username && env.MAX_BOT_NAME !== me.username)
    line("! MAX_BOT_NAME differs", `${env.MAX_BOT_NAME} ≠ ${me.username}`);
}

const subs = await step("GET /subscriptions", () => api.getSubscriptions());
if (subs) {
  const list = subs.subscriptions ?? [];
  line("✓ GET /subscriptions", `${list.length} subscription(s)`);
  for (const s of list)
    line("  webhook", `${s.url} types=${(s.update_types ?? ["all"]).join(",")}`);
  line(
    "delivery",
    list.length
      ? "webhook active → long polling (BOT_MODE=polling) will NOT receive updates"
      : "no webhook → long polling works; production should use BOT_MODE=webhook",
  );
}

const botName = String(env.MAX_BOT_NAME || me?.username || "").trim();

section("What the bot needs");
line("BOT_MODE", env.BOT_MODE || "(default: webhook if BOT_WEBHOOK_URL is set, else polling)");
line("MAX_BOT_NAME", env.MAX_BOT_NAME || `(empty → ${me?.username || "unknown"})`);
line("BOT_WEBHOOK_URL", env.BOT_WEBHOOK_URL || "(not set)");
line(
  "BOT_WEBHOOK_SECRET",
  env.BOT_WEBHOOK_SECRET
    ? WEBHOOK_SECRET.test(env.BOT_WEBHOOK_SECRET)
      ? "set, format ok"
      : "set, INVALID (5–256 chars A-Z a-z 0-9 _ -)"
    : "(not set – required for webhook mode)",
);
line("BOT_REMINDERS", env.BOT_REMINDERS || "off");
if (botName) {
  line("bot deep link", `https://max.ru/${botName}?start=calendar`);
  line("mini-app deep link", `https://max.ru/${botName}?startapp=tab_calendar`);
}

if (args.has("register-commands")) {
  section("PATCH /me/commands");
  const r = await step("PATCH /me/commands", () => api.setCommands(COMMANDS));
  if (r) line("✓ commands", JSON.stringify(r));
}

if (args.has("resubscribe")) {
  section("POST /subscriptions");
  if (!env.BOT_WEBHOOK_URL || !env.BOT_WEBHOOK_SECRET) {
    line("✗ skipped", "set BOT_WEBHOOK_URL and BOT_WEBHOOK_SECRET");
    failures += 1;
  } else {
    const r = await step("POST /subscriptions", () =>
      api.subscribe({
        url: String(env.BOT_WEBHOOK_URL),
        secret: String(env.BOT_WEBHOOK_SECRET),
        update_types: UPDATE_TYPES,
      }),
    );
    if (r) line("✓ subscribed", JSON.stringify(r));
  }
}

if (args.has("unsubscribe")) {
  section("DELETE /subscriptions");
  const url = args.get("unsubscribe") !== "true" ? args.get("unsubscribe") : env.BOT_WEBHOOK_URL;
  if (!url) {
    line("✗ skipped", "pass --unsubscribe=<url> or set BOT_WEBHOOK_URL");
    failures += 1;
  } else {
    const r = await step("DELETE /subscriptions", () =>
      api.request("DELETE", "/subscriptions", { query: { url } }),
    );
    if (r) line("✓ unsubscribed", JSON.stringify(r));
  }
}

if (args.has("send-to")) {
  section("POST /messages");
  const userId = String(args.get("send-to"));
  if (!/^\d+$/.test(userId)) {
    line("✗ skipped", "--send-to needs a numeric MAX user id");
    failures += 1;
  } else {
    const body = greetingScreen(
      {
        app: { webApp: botName || null, contactId: Number(me?.user_id) || null },
        remindersAvailable: false,
        today: moscowToday(Date.now()),
      },
      { firstName: null, openPayload: "tab_calendar" },
    );
    const r = await step("POST /messages", () => api.sendMessage({ userId }, body));
    if (r) {
      line("✓ sent", `mid=${r?.message?.body?.mid ?? "?"}`);
      line("check manually", "«Открыть Олимпус» opens the mini-app on the calendar tab");
    }
  }
}

section("Check by hand (НЕ ПОДТВЕРЖДЕНО in the docs)");
for (const item of [
  "open_app: web_app = bot username (GET /me) opens the mini-app on iOS, Android and web",
  "open_app.payload arrives in the mini-app as start_param (confirmed only for web)",
  "initData user.id in the mini-app equals user_id in bot updates (progress key max:<id>)",
  "PATCH /me/commands: names without «/» show up in the command menu",
  "markdown backslash escapes (e.g. C\\+\\+) render without the backslash",
])
  console.log(`- ${item}`);

process.exit(failures ? 1 : 0);
