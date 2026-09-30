// Dev helper: screenshots of app screens (not part of the test suite).
// Usage: node tests/support/shoot.mjs <baseUrl> <outDir> <name> <hash> [w] [h] [scheme] [full]
import { chromium } from "@playwright/test";

const [, , base, out, name, hash = "#/home", w = "390", h = "844", scheme = "light", full = ""] =
  process.argv;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 1,
  colorScheme: scheme,
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
  isMobile: Number(w) < 700,
  hasTouch: Number(w) < 700,
});
await context.route("https://st.max.ru/**", (r) =>
  r.fulfill({ contentType: "text/javascript", body: "" }),
);
const settings = process.env.SHOOT_SETTINGS ?? '{"onboarded":true,"grade":5,"subject":"math"}';
await context.addInitScript((value) => {
  try {
    if (value !== "none") localStorage.setItem("olympus.settings", value);
  } catch {
    /* storage blocked */
  }
}, settings);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
const ready = ".ol-page-header h1, .ol-onboarding h1, .ol-admin-header h1";
for (let i = 0; i < 4; i++) {
  await page.goto(base + "/" + hash);
  const ok = await page
    .waitForSelector(ready, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (ok) break;
  console.log("retrying", hash);
}
await page.waitForTimeout(Number(process.env.SHOOT_WAIT ?? 700));
await page.screenshot({ path: `${out}/${name}.png`, fullPage: full === "full" });
await browser.close();
