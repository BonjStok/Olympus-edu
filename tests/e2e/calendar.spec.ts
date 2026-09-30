/**
 * Olympiad calendar with the real published data: regional editions collapse into one card
 * until a region is chosen, registration on the organiser's site, the month grid.
 */
import { expect, test } from "@playwright/test";
import {
  loadContent,
  pickLinkOlympiad,
  pickRegion,
  pickSchoolStage,
  prepare,
  presetLearner,
  screenTitle,
  serveOlympiads,
  seriesRegions,
} from "./helpers";

const MONTHS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

test("without a region a series is one card; «Выбрать регион» narrows it to the region", async ({
  context,
  page,
  request,
}) => {
  const content = await loadContent(request);
  const school = pickSchoolStage(content);
  const series = school.event.series as string;
  await prepare(context);
  await presetLearner(context, { grade: 5, subject: "math" });
  await serveOlympiads(context, [school]);
  await page.goto("/#/calendar");
  await screenTitle(page, "Олимпиады");
  await expect(page.getByText("Показаны: 5 класс · математика · все регионы")).toBeVisible();

  // One card for all regional editions, with the number of regions and no dates of its own.
  const seriesCard = page.locator(".ol-series-card", {
    hasText: `в ${seriesRegions(content, series)} регион`,
  });
  await expect(seriesCard.first()).toBeVisible();
  await expect(seriesCard.first()).toContainText("даты зависят от региона");
  await expect(page.getByRole("button", { name: school.event.title })).toHaveCount(0);

  // «Выбрать регион» opens the filters with the region field ready for typing.
  await seriesCard.first().getByRole("button", { name: "Выбрать регион" }).click();
  const regionField = page.getByRole("combobox", { name: "Регион", exact: true });
  await expect(regionField).toBeFocused();
  await pickRegion(page, regionField, school.event.region);
  await expect(
    page.getByText(`Показаны: 5 класс · математика · ${school.event.region} и вся Россия`),
  ).toBeVisible();
  await expect(page.locator(".ol-series-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: school.event.title })).toBeVisible();
});

test("registration on the organiser's site asks whether it worked", async ({
  context,
  page,
  request,
}) => {
  const content = await loadContent(request);
  const link = pickLinkOlympiad(content);
  await prepare(context);
  await presetLearner(context, { grade: 5, subject: "math" });
  await serveOlympiads(context, [link]);
  await page.goto("/#/calendar");
  await screenTitle(page, "Олимпиады");
  await page.getByRole("button", { name: link.event.title }).first().click();
  await screenTitle(page, link.event.title);
  const deadline = link.patch?.deadline ?? link.event.deadline;
  await expect(
    page.getByText(
      /^(Регистрация до .+ · (осталось|остался|последний)|Срок регистрации уточняется)/,
    ),
  ).toBeVisible();
  if (deadline && /^\d{4}-/.test(deadline))
    await expect(page.getByText(/^Регистрация до /)).toBeVisible();

  // A plain browser opens the site in a new tab; back in the app it asks about the result.
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Зарегистрироваться на сайте" }).click();
  const site = await popup;
  await site.waitForLoadState();
  expect(site.url()).toBe(new URL(link.event.url).href);
  await page.bringToFront();
  await expect(page.getByRole("heading", { name: "Получилось зарегистрироваться?" })).toBeVisible();
  await page.getByRole("button", { name: "Да, я участвую" }).click();
  await expect(page.getByText("Ты участвуешь", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Готовиться" })).toBeVisible();

  // The mark can be taken back.
  await page.getByRole("button", { name: "Убрать отметку" }).click();
  await expect(page.getByText("Отметка убрана")).toBeVisible();
  await expect(page.getByRole("button", { name: "Зарегистрироваться на сайте" })).toBeVisible();
});

test("the month grid shows the same olympiads as the list", async ({ context, page, request }) => {
  const content = await loadContent(request);
  const school = pickSchoolStage(content);
  const event = { ...school.event, ...school.patch };
  await prepare(context);
  await presetLearner(context, { grade: 5, subject: "math", region: event.region });
  await serveOlympiads(context, [school]);
  await page.goto("/#/calendar");
  await screenTitle(page, "Олимпиады");
  await expect(page.getByRole("button", { name: event.title })).toBeVisible();

  await page.getByRole("radio", { name: "Календарём" }).click();
  const [year, month, day] = event.date.split("-").map(Number);
  const heading = page.locator(".ol-month-head h3");
  const target = `${MONTHS[month - 1]} ${year}`;
  for (let i = 0; i < 24 && (await heading.textContent()) !== target; i++)
    await page.getByRole("button", { name: "Следующий месяц" }).click();
  await expect(heading).toHaveText(target);

  const cell = page.locator(".ol-month-days button.has-event", { hasText: new RegExp(`^${day}$`) });
  await expect(cell).toBeEnabled();
  await cell.click();
  // One olympiad that day opens it; several are listed under the grid.
  const title = page.getByRole("heading", { level: 1, name: event.title });
  const panel = page.locator(".ol-day-panel");
  await expect(title.or(panel)).toBeVisible();
  if (await panel.isVisible()) await panel.getByRole("button", { name: event.title }).click();
  await screenTitle(page, event.title);
});
