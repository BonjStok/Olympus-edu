/**
 * The mock timer follows the server clock: a child's phone can be hours off, and the attempt
 * ends by the server's time. Also: a device clock that jumps ahead must not finish the attempt.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  loadContent,
  openTab,
  pickMock,
  prepare,
  presetLearner,
  screenTitle,
  timerSeconds,
  type PickedMock,
} from "./helpers";

/** Seconds the shown time may differ from the server's (network latency, rounding up). */
const TOLERANCE = 3;

async function startMock(page: Page, picked: PickedMock) {
  await page.goto("/#/mocks");
  await screenTitle(page, "Пробники");
  await page
    .locator("article", { has: page.getByRole("heading", { name: picked.mock.title }) })
    .getByRole("button", { name: "Начать пробник" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Начать" }).click();
  await expect(page.getByRole("timer")).toBeVisible();
}

/** Seconds left as shown by a timer-like text, e.g. «Идёт попытка · осталось 59:12». */
async function secondsIn(page: Page, locator: ReturnType<Page["locator"]>): Promise<number> {
  const text = (await locator.textContent()) ?? "";
  const match = /(\d+:)?\d+:\d\d/.exec(text);
  expect(match, `a countdown in «${text}»`).not.toBeNull();
  return timerSeconds(match![0]);
}

async function skewedPage(context: BrowserContext, hours: number): Promise<Page> {
  const page = await context.newPage();
  await page.clock.install({ time: new Date(Date.now() + hours * 3600_000) });
  return page;
}

for (const hours of [5, -5]) {
  test(`the timer shows the real time left when the device clock is ${hours > 0 ? "ahead" : "behind"} by ${Math.abs(hours)} h`, async ({
    context,
    request,
  }) => {
    const picked = pickMock(await loadContent(request));
    const full = picked.mock.minutes * 60;
    await prepare(context);
    await presetLearner(context, { grade: 5, subject: "math" });
    const page = await skewedPage(context, hours);
    await startMock(page, picked);
    const timer = page.getByRole("timer");
    const left = await secondsIn(page, timer);
    expect(left).toBeGreaterThan(full - 120);
    expect(left).toBeLessThanOrEqual(full + TOLERANCE);

    // Leaving the attempt: the list and the banner agree with the timer.
    await openTab(page, "Пробники");
    await page
      .getByRole("dialog", { name: "Выйти из пробника?" })
      .getByRole("button", { name: "Выйти" })
      .click();
    await screenTitle(page, "Пробники");
    const card = page.locator("article", {
      has: page.getByRole("heading", { name: picked.mock.title }),
    });
    await expect(card.getByRole("button", { name: "Продолжить" })).toBeVisible();
    expect(await secondsIn(page, card.locator(".ol-mock-result"))).toBeGreaterThan(full - 180);
    expect(await secondsIn(page, page.locator(".ol-running-mock"))).toBeGreaterThan(full - 180);

    // Reopened in a new tab (nothing cached in the session yet): still the real time.
    const again = await skewedPage(context, hours);
    await again.goto("/#/mocks");
    await screenTitle(again, "Пробники");
    const cardAgain = again.locator("article", {
      has: again.getByRole("heading", { name: picked.mock.title }),
    });
    await expect(cardAgain.getByRole("button", { name: "Продолжить" })).toBeVisible();
    const leftAgain = await secondsIn(again, cardAgain.locator(".ol-mock-result"));
    expect(leftAgain).toBeGreaterThan(full - 180);
    expect(leftAgain).toBeLessThanOrEqual(full + TOLERANCE);
    await cardAgain.getByRole("button", { name: "Продолжить" }).click();
    expect(await secondsIn(again, again.getByRole("timer"))).toBeGreaterThan(full - 180);
  });
}

test("a device clock that jumps ahead does not finish the attempt early", async ({
  context,
  page,
  request,
}) => {
  const picked = pickMock(await loadContent(request));
  const full = picked.mock.minutes * 60;
  await prepare(context);
  await presetLearner(context, { grade: 5, subject: "math" });
  await page.clock.install();
  await startMock(page, picked);
  await page.getByRole("textbox", { name: "Твой ответ" }).fill(picked.task.answer ?? "1");

  // The phone's clock jumps past the end of the mock (the server's clock does not).
  await page.clock.fastForward((picked.mock.minutes + 1) * 60_000);
  // The app double-checks with the server and keeps going with the real time left.
  await expect
    .poll(async () => secondsIn(page, page.getByRole("timer")), { timeout: 15_000 })
    .toBeGreaterThan(full - 180);
  await expect(page.getByText("Результат пробника")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Твой ответ" })).toBeEditable();
});
