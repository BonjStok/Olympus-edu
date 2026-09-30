/**
 * MAX integration with a fake MAX Bridge (served instead of st.max.ru/js/max-web-app.js):
 * deep link, ready(), BackButton, openLink, haptics, closing confirmation.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  loadContent,
  openTab,
  pickLinkOlympiad,
  pickMock,
  prepare,
  presetLearner,
  screenTitle,
  serveOlympiads,
} from "./helpers";

function fakeBridge(startParam: string) {
  return `
    window.__max = [];
    const log = (name, arg) => window.__max.push(arg === undefined ? name : name + ":" + JSON.stringify(arg));
    let back = [];
    window.WebApp = {
      initData: "query_id=e2e&auth_date=1&hash=0",
      initDataUnsafe: { start_param: ${JSON.stringify(startParam)} },
      platform: "android",
      ready: () => log("ready"),
      openLink: (url) => log("openLink", url),
      openMaxLink: (url) => log("openMaxLink", url),
      enableClosingConfirmation: () => log("closing:on"),
      disableClosingConfirmation: () => log("closing:off"),
      BackButton: {
        show: () => log("back:show"),
        hide: () => log("back:hide"),
        onClick: (cb) => back.push(cb),
        offClick: (cb) => (back = back.filter((x) => x !== cb)),
      },
      HapticFeedback: {
        impactOccurred: (s) => (log("haptic", s), Promise.resolve({})),
        notificationOccurred: (s) => (log("haptic", s), Promise.resolve({})),
        selectionChanged: () => (log("haptic", "selection"), Promise.resolve({})),
      },
      getLaunchContext: () => Promise.resolve({ entryPoint: "default" }),
    };
    window.__pressBack = () => back.forEach((cb) => cb());
  `;
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __max: string[] }).__max);

test("a deep link opens the olympiad; Back, openLink and haptics go through MAX", async ({
  context,
  page,
  request,
}) => {
  const content = await loadContent(request);
  const link = pickLinkOlympiad(content);
  const { event } = link;
  await prepare(context, fakeBridge(`event_${event.id}`));
  await presetLearner(context, { grade: 5, subject: "math" });
  await serveOlympiads(context, [link]);
  await page.goto("/#WebAppData=query_id%3De2e&WebAppPlatform=android");

  // start_param=event_<id> opens that olympiad.
  await screenTitle(page, event.title);
  await expect(page).toHaveURL(new RegExp(`#/calendar/event/${event.id}$`));
  await expect.poll(() => calls(page)).toContain("ready");
  await expect.poll(() => calls(page)).toContain("back:show");

  // The organiser's site opens through WebApp.openLink, then the app asks about the result.
  await page.getByRole("button", { name: "Зарегистрироваться на сайте" }).click();
  await expect.poll(() => calls(page)).toContain(`openLink:${JSON.stringify(event.url)}`);
  await expect(page.getByRole("heading", { name: "Получилось зарегистрироваться?" })).toBeVisible();
  await page.getByRole("button", { name: "Да, я участвую" }).click();
  await expect(page.getByText("Ты участвуешь", { exact: true }).first()).toBeVisible();
  await expect.poll(() => calls(page)).toContain('haptic:"success"');

  // The native Back button returns to the list and hides itself on the root screen.
  await page.evaluate(() => (window as unknown as { __pressBack(): void }).__pressBack());
  await screenTitle(page, "Олимпиады");
  await expect.poll(() => calls(page)).toContain("back:hide");

  // The fake launch payload cannot authenticate on a local stack, but the active MAX bridge
  // must be visible in the guest diagnostics.
  await openTab(page, "Я");
  await screenTitle(page, "Я");
  await expect(page.getByRole("heading", { name: "Ты занимаешься как гость" })).toBeVisible();
  await expect(page.getByText(/Состояние входа: мост MAX - есть/)).toBeVisible();
});

test("a running mock asks MAX to confirm closing", async ({ context, page, request }) => {
  const { mock } = pickMock(await loadContent(request));
  await prepare(context, fakeBridge(""));
  await presetLearner(context, { grade: 5, subject: "math" });
  await page.goto("/#/mocks");
  await screenTitle(page, "Пробники");
  await page
    .locator("article", { has: page.getByRole("heading", { name: mock.title }) })
    .getByRole("button", { name: "Начать пробник" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Начать" }).click();
  await expect(page.getByRole("timer")).toBeVisible();
  await expect.poll(() => calls(page)).toContain("closing:on");
  await expect.poll(() => calls(page)).toContain('haptic:"medium"');

  // Finishing turns the confirmation off again.
  await page.getByRole("button", { name: "Завершить", exact: true }).first().click();
  await page
    .getByRole("dialog", { name: "Завершить пробник?" })
    .getByRole("button", { name: "Завершить", exact: true })
    .click();
  await expect(page.getByText("Результат пробника")).toBeVisible();
  await expect.poll(() => calls(page)).toContain("closing:off");
});
