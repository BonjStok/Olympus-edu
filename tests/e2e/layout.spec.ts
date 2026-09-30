/**
 * On a phone the page never scrolls sideways, even with a wide system font (DejaVu Sans on
 * Linux, enlarged fonts on Android). A single wide element used to stretch the whole screen
 * of a running mock, and the bottom tab bar then sat under the task card.
 */
import { expect, test, type Page } from "@playwright/test";
import { loadContent, pickMock, prepare, presetLearner, screenTitle } from "./helpers";

async function useWideFont(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "*{font-family: Verdana, 'DejaVu Sans', sans-serif !important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
  });
}

async function expectNoSideScroll(page: Page, where: string) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `${where}: page is ${scroll}px wide on a ${client}px screen`).toBeLessThanOrEqual(
    client,
  );
}

test.skip(({ isMobile }) => !isMobile, "phone layout only");

test("tabs fit the phone screen with a wide font", async ({ context }) => {
  await prepare(context);
  await presetLearner(context, { grade: 5, subject: "math" });
  const page = await context.newPage();
  await useWideFont(page);
  for (const [route, title] of [
    ["/#/calendar", "Олимпиады"],
    ["/#/learn", "Учёба"],
    ["/#/mocks", "Пробники"],
    ["/#/profile", "Я"],
  ] as const) {
    await page.goto(route);
    await screenTitle(page, title);
    await expectNoSideScroll(page, route);
  }
});

test("a running mock fits the phone screen with a wide font", async ({ context, request }) => {
  const picked = pickMock(await loadContent(request));
  await prepare(context);
  await presetLearner(context, { grade: 5, subject: "math" });
  const page = await context.newPage();
  await useWideFont(page);
  await page.goto("/#/mocks");
  await screenTitle(page, "Пробники");
  await page
    .locator("article", { has: page.getByRole("heading", { name: picked.mock.title }) })
    .getByRole("button", { name: "Начать пробник" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Начать" }).click();
  await expect(page.getByRole("timer")).toBeVisible();
  await expectNoSideScroll(page, "running mock");
});

async function expectOneRow(page: Page, where: string) {
  const group = page.getByRole("radiogroup", { name: "Предмет" }).first();
  await expect(group.getByRole("radio")).toHaveCount(3);
  const tops = await group
    .getByRole("radio")
    .evaluateAll((radios) => radios.map((r) => Math.round(r.getBoundingClientRect().top)));
  expect(new Set(tops).size, `${where}: «Математика», «Информатика», «Обе» в одну строку`).toBe(1);
  const clipped = await group
    .getByRole("radio")
    .evaluateAll((radios) => radios.filter((r) => r.scrollWidth > r.clientWidth + 1).length);
  expect(clipped, `${where}: подписи помещаются в кнопки`).toBe(0);
}

for (const width of [390, 320]) {
  test(`subjects stay in one row on a ${width}px phone`, async ({ context }) => {
    await prepare(context);
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 800 });
    await useWideFont(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Привет! Я Олимпус" })).toBeVisible({
      timeout: 20_000,
    });
    await expectOneRow(page, "первый вход");
  });
}

test("subjects stay in one row in the class and subject dialog", async ({ context }) => {
  await prepare(context);
  await presetLearner(context, { grade: 4, subject: "math" });
  const page = await context.newPage();
  await useWideFont(page);
  await page.goto("/#/");
  await page.getByRole("button", { name: /Изменить класс и предмет/ }).click();
  await expect(page.getByRole("dialog", { name: "Твой класс и предмет" })).toBeVisible();
  await expectOneRow(page, "диалог");
});
