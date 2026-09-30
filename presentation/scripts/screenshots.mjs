#!/usr/bin/env node
/**
 * Re-shoots the phone screens used in the deck from a running «Олимпус» app.
 *
 * Walks the real interface like a child would: first-run screen → «Олимпиады» → olympiad card →
 * «Я участвую» → «Учёба» → lesson → task → «Пробники» → mock test with correct answers from the
 * content → «Главная» → «Я», plus the teacher cabinet and the dark theme. Every screen is one
 * phone viewport (390×844 CSS px) saved as
 * JPEG q85 at 2× (780×1688) to presentation/assets/screens/<name>.jpg; the list goes to
 * presentation/assets/screens/manifest.json. Toasts are hidden so they never cover content.
 *
 *   BASE_URL=http://localhost:3000 ADMIN_PASSWORD=… node presentation/scripts/screenshots.mjs
 *
 * Environment:
 *   BASE_URL        app address (default http://localhost:3000). The walk creates guest progress
 *                   and an «Я участвую» mark, so non-local hosts need ALLOW_WRITES=1.
 *   REGION          region for the first-run screen (default «Республика Татарстан»)
 *   GRADE           class 4, 5 or 6 (default 5)
 *   TOPIC           math topic for lesson and tasks (default math-5-01)
 *   CODE_TOPIC      informatics topic with a code task (default info-5-01)
 *   EVENT_ID        olympiad id for the card; by default the first card in «Олимпиады» is used
 *   ADMIN_PASSWORD  teacher cabinet password; without it the three cabinet screens are skipped
 *   ONLY            comma-separated screen names to re-shoot, e.g. ONLY=event,profile
 *   MOCK_RIGHT      how many mock answers to fill in correctly (default 7)
 *   NOW             fake "now" (ISO date) for stable "осталось N дней" labels
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(HERE, "..", "assets", "screens");
const env = process.env;
const BASE = (env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const REGION = env.REGION || "Республика Татарстан";
const GRADE = String(env.GRADE || "5");
const TOPIC = env.TOPIC || `math-${GRADE}-01`;
const CODE_TOPIC = env.CODE_TOPIC || `info-${GRADE}-01`;
const ONLY = env.ONLY ? new Set(env.ONLY.split(",").map((s) => s.trim())) : null;

// Screen name → what it shows. The deck references exactly these names.
const SCREENS = {
  onboarding: "первый запуск: класс, предмет, регион",
  "region-picker": "выбор региона с поиском",
  calendar: "«Олимпиады», список",
  "calendar-month": "«Олимпиады», календарь на месяц",
  event: "карточка олимпиады: регистрация, «проверено · источник»",
  "event-registered": "после «Я участвую»",
  learn: "«Учёба», карта тем",
  lesson: "урок темы",
  "practice-wrong": "неверный ответ с объяснением",
  "practice-right": "верный ответ",
  "code-task": "задача по информатике с кодом",
  mocks: "«Пробники»",
  "mock-attempt": "пробный тур с таймером",
  "mock-leave": "подтверждение выхода из пробника",
  "mock-result": "результат пробного тура",
  home: "«Главная»: мои олимпиады и следующий шаг",
  profile: "«Я»: звёзды, медали, мои олимпиады",
  privacy: "политика конфиденциальности",
  "admin-list": "кабинет учителя: материалы",
  "admin-import": "кабинет учителя: загрузка таблицы",
  "admin-editor": "кабинет учителя: новая олимпиада",
  "dark-learn": "тёмная тема, «Учёба»",
};

if (
  !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE) &&
  env.ALLOW_WRITES !== "1"
) {
  console.error(
    `${BASE} is not local: the walk writes guest progress. Set ALLOW_WRITES=1 to proceed.`,
  );
  process.exit(1);
}

const tasks = JSON.parse(
  fs.readFileSync(path.join(ROOT, "content", "tasks", `math-${GRADE}.json`), "utf8"),
);
const firstTask = tasks.filter((t) => t.topicId === TOPIC).sort((a, b) => a.order - b.order)[0];
if (!firstTask) throw new Error(`no tasks for ${TOPIC}`);
const rightAnswer = String(firstTask.answer);
const wrongAnswer = /^\d+$/.test(rightAnswer) ? String(Number(rightAnswer) + 1) : "0";

// Correct answers for the grade's mock test, so the result screen shows a realistic score.
const mockTest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "content", "mock-tests", "initial.json"), "utf8"),
).find((m) => m.id === `mock-${GRADE}-math`);
const answerOf = new Map(tasks.map((t) => [t.id, String(t.answer)]));
const MOCK_RIGHT = Number(env.MOCK_RIGHT || 7);

const manifest = {
  device: { width: 390, height: 844, deviceScaleFactor: 2 },
  baseUrl: BASE,
  screens: {},
};
const manifestFile = path.join(OUT, "manifest.json");
if (ONLY && fs.existsSync(manifestFile))
  Object.assign(manifest.screens, JSON.parse(fs.readFileSync(manifestFile)).screens);

const browser = await chromium.launch();

async function context({ scheme = "light", settings = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
  });
  // Outside MAX the bridge script is not needed; the app then runs in guest mode.
  await ctx.route("https://st.max.ru/**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: "" }),
  );
  await ctx.addInitScript(
    (s) => {
      if (s) localStorage.setItem("olympus.settings", s);
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = ".ol-toasts{display:none!important}";
        document.head.append(style);
      });
    },
    settings && JSON.stringify(settings),
  );
  const page = await ctx.newPage();
  if (env.NOW) await page.clock.install({ time: new Date(env.NOW) });
  page.on("pageerror", (e) => console.warn("  ! page error:", e.message));
  return { ctx, page };
}

const ready = (page) =>
  page
    .locator(".ol-page-header h1, .ol-onboarding h1, .ol-admin-header h1")
    .first()
    .waitFor({ timeout: 30_000 });

async function shot(page, name) {
  if (!SCREENS[name]) throw new Error(`unknown screen ${name}`);
  if (ONLY && !ONLY.has(name)) return;
  await page.waitForTimeout(500);
  await page.evaluate(() => document.fonts.ready);
  const file = `${name}.jpg`;
  await page.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: 85 });
  manifest.screens[name] = { file, shows: SCREENS[name], capturedAt: new Date().toISOString() };
  console.log("•", file);
}

async function tab(page, label) {
  await page.locator("nav.ol-tabbar").getByRole("button", { name: label, exact: true }).click();
  await ready(page);
}

async function child() {
  const { ctx, page } = await context();
  await page.goto(`${BASE}/`);
  await ready(page);
  await page.getByRole("radio", { name: `${GRADE} класс` }).click();
  await page.getByRole("radio", { name: "Математика" }).click();
  const region = page.getByRole("combobox", { name: /Регион|Где ты учишься/ });
  await region.fill(REGION.replace(/^Республика /, "").slice(0, 5));
  await shot(page, "region-picker");
  await page.getByRole("option", { name: REGION }).click();
  await shot(page, "onboarding");
  await page.getByRole("button", { name: "Начать" }).click();
  await ready(page);

  await tab(page, "Олимпиады");
  await shot(page, "calendar");
  await page.getByRole("radio", { name: "Календарём" }).click();
  await shot(page, "calendar-month");
  if (env.EVENT_ID) await page.goto(`${BASE}/#/calendar/event/${env.EVENT_ID}`);
  else {
    await page.getByRole("radio", { name: "Списком" }).click();
    await page.locator(".ol-event-card-btn").first().click();
  }
  await ready(page);
  await shot(page, "event");
  await page.getByRole("button", { name: "Я участвую" }).click();
  await page.getByText("Ты участвуешь").first().waitFor();
  await shot(page, "event-registered");

  await tab(page, "Учёба");
  await shot(page, "learn");
  await page.goto(`${BASE}/#/learn/topic/${TOPIC}/theory/1`);
  await ready(page);
  await shot(page, "lesson");
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Дальше" }).click();
  await page.getByRole("button", { name: "Завершить теорию" }).click();
  await page.getByRole("button", { name: "К практике" }).click();
  const answer = page.getByRole("textbox", { name: "Твой ответ" });
  await answer.fill(wrongAnswer);
  await page.getByRole("button", { name: "Проверить" }).click();
  await page.getByText("Пока неверно").waitFor();
  await shot(page, "practice-wrong");
  await answer.fill(rightAnswer);
  await page.getByRole("button", { name: "Проверить" }).click();
  await page
    .getByText(/Верно!/)
    .first()
    .waitFor();
  await shot(page, "practice-right");

  await tab(page, "Учёба");
  await page.getByRole("radio", { name: "Информатика" }).click();
  await page.goto(`${BASE}/#/learn/topic/${CODE_TOPIC}/practice/1`);
  await ready(page);
  await shot(page, "code-task");
  await tab(page, "Учёба");
  await page.getByRole("radio", { name: "Математика" }).click();

  await tab(page, "Пробники");
  await shot(page, "mocks");
  await page
    .locator("article", { has: page.getByRole("heading", { name: /^Пробный тур/ }) })
    .first()
    .getByRole("button", { name: "Начать пробник" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Начать" }).click();
  await page.getByRole("timer").waitFor();
  const mockAnswer = page.getByRole("textbox", { name: "Твой ответ" });
  await mockAnswer.fill(answerOf.get(mockTest?.taskIds[0]) ?? rightAnswer);
  await shot(page, "mock-attempt");
  for (let i = 1; mockTest && i < Math.min(MOCK_RIGHT, mockTest.taskIds.length); i++) {
    const value = answerOf.get(mockTest.taskIds[i]);
    if (!value) continue;
    await page.getByRole("button", { name: new RegExp(`^Задание ${i + 1},`) }).click();
    await mockAnswer.fill(value);
    await page.waitForTimeout(300);
  }
  await page
    .locator("nav.ol-tabbar")
    .getByRole("button", { name: "Олимпиады", exact: true })
    .click();
  await shot(page, "mock-leave");
  await page.getByRole("dialog").getByRole("button", { name: "Остаться" }).click();
  await page.getByRole("button", { name: "Завершить", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Завершить", exact: true }).click();
  await page.getByText("Результат пробника").waitFor();
  await shot(page, "mock-result");

  await tab(page, "Главная");
  await shot(page, "home");
  await tab(page, "Я");
  await shot(page, "profile");
  await page.goto(`${BASE}/#/profile/legal/privacy`);
  await ready(page);
  await shot(page, "privacy");

  if (env.ADMIN_PASSWORD) {
    await page.goto(`${BASE}/#/admin/olympiads`);
    await ready(page);
    await page.getByLabel("Пароль учителя").fill(env.ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await page.getByRole("heading", { level: 1, name: "Олимпиады" }).waitFor();
    await shot(page, "admin-list");
    await page.getByRole("button", { name: "Импорт из файла" }).click();
    await shot(page, "admin-import");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Добавить олимпиаду" }).click();
    await page.getByRole("heading", { level: 1, name: "Новая олимпиада" }).waitFor();
    await shot(page, "admin-editor");
  } else console.warn("  ! ADMIN_PASSWORD is not set: cabinet screens are kept as they are");
  await ctx.close();
}

async function dark() {
  const settings = { onboarded: true, grade: Number(GRADE), subject: "math", region: REGION };
  const { ctx, page } = await context({ scheme: "dark", settings });
  await page.goto(`${BASE}/#/learn`);
  await ready(page);
  await shot(page, "dark-learn");
  await ctx.close();
}

try {
  await child();
  await dark();
} finally {
  await browser.close();
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(
  `\nscreens: ${Object.keys(manifest.screens).length} → ${path.relative(process.cwd(), OUT)}`,
);
