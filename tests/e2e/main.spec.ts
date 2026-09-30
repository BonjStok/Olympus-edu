/**
 * The main scenario of a child, end to end against a running stack:
 * first run with a region → calendar narrowed to that region → a school-stage olympiad
 * («Я участвую») → profile → theory with a star → practice (wrong, then right) →
 * mock test (start, answer, finish, results) → profile stats.
 */
import { expect, test } from "@playwright/test";
import {
  escapeRegExp,
  expandCollapsedSections,
  finishOnboarding,
  loadContent,
  openTab,
  pickFirstTopic,
  pickMock,
  pickSchoolStage,
  prepare,
  promptStart,
  screenTitle,
  serveOlympiads,
  timerSeconds,
  wrongAnswer,
} from "./helpers";

test("the child's main path", async ({ context, page, request }) => {
  test.setTimeout(150_000);
  const content = await loadContent(request);
  const school = pickSchoolStage(content);
  const region = school.event.region;
  const { topic, lessons, task, taskIndex } = pickFirstTopic(content);
  const mock = pickMock(content);
  await prepare(context);
  await serveOlympiads(context, [school]);
  await page.goto("/");

  // First run: class, subject, region.
  await finishOnboarding(page, { grade: "5 класс", subject: "Математика", region });
  await expect(page.getByRole("button", { name: /5 класс · Математика/ })).toBeVisible();

  // Calendar: only all-Russia olympiads and the chosen region, no collapsed series.
  await openTab(page, "Олимпиады");
  await screenTitle(page, "Олимпиады");
  await expect(
    page.getByText(`Показаны: 5 класс · математика · ${region} и вся Россия`),
  ).toBeVisible();
  const card = page.locator("article.ol-event-card", {
    has: page.getByRole("button", { name: school.event.title }),
  });
  await expect(card).toHaveCount(1);
  await expandCollapsedSections(page);
  await expect(page.locator(".ol-series-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Выбрать регион" })).toHaveCount(0);
  const places = await page.locator(".ol-event-card .ol-event-meta").allTextContents();
  expect(places.length).toBeGreaterThan(1);
  for (const place of places)
    expect(place, "every olympiad is all-Russia or from the chosen region").toMatch(
      new RegExp(`вся Россия|по всей России|${escapeRegExp(region)}`),
    );

  // A school-stage olympiad: no deadline, the school registers, «Я участвую».
  await card.getByRole("button", { name: school.event.title }).click();
  await screenTitle(page, school.event.title);
  await expect(page.getByText(/Записывает школа – спроси учителя/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Как участвовать" })).toBeVisible();
  await expect(page.getByText(/Регистрация до/)).toHaveCount(0);
  await page.getByRole("button", { name: "Я участвую" }).click();
  await expect(page.getByText("Ты участвуешь", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Готово! Олимпиада в твоём профиле и на главной")).toBeVisible();

  // Browser Back returns to the list, not out of the app; the card is marked.
  await page.goBack();
  await screenTitle(page, "Олимпиады");
  await expect(card).toContainText("Ты участвуешь");

  // Profile shows the olympiad.
  await openTab(page, "Я");
  await screenTitle(page, "Я");
  const mine = page.locator("section", {
    has: page.getByRole("heading", { name: /Мои олимпиады/ }),
  });
  await expect(mine.getByText(school.event.title)).toBeVisible();

  // Theory: the recommended topic, every lesson, the star.
  await openTab(page, "Учёба");
  await screenTitle(page, "Учёба");
  await expect(page.locator(".ol-next-topic h2")).toHaveText(topic.title);
  await page.locator(".ol-next-topic").getByRole("button", { name: "Начать" }).click();
  await screenTitle(page, topic.title);
  for (let i = 0; i < lessons.length - 1; i++) {
    await expect(page.getByText(`Урок ${i + 1} из ${lessons.length}`)).toBeVisible();
    await page.getByRole("button", { name: "Дальше" }).click();
  }
  await expect(page.getByText(`Урок ${lessons.length} из ${lessons.length}`)).toBeVisible();
  await page.getByRole("button", { name: "Завершить теорию" }).click();
  await expect(page.getByText("Теория пройдена!")).toBeVisible();
  await expect(page.getByRole("button", { name: "Звёзд: 1. Открыть профиль" })).toBeVisible();

  // Practice: a wrong answer, then the right one.
  await page.getByRole("button", { name: "К практике" }).click();
  if (taskIndex > 0) await page.getByRole("button", { name: `Задача ${taskIndex + 1}` }).click();
  await expect(page.getByText(promptStart(task)).first()).toBeVisible();
  const answer = page.getByRole("textbox", { name: "Твой ответ" });
  await answer.fill(wrongAnswer(task.answer ?? ""));
  await page.getByRole("button", { name: "Проверить" }).click();
  await expect(page.getByText("Пока неверно. Попробуй ещё раз или возьми подсказку")).toBeVisible();
  await answer.fill(task.answer ?? "");
  await answer.press("Enter");
  await expect(page.getByText("Верно! Отличная работа")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Задача ${taskIndex + 1}, решена`, exact: true }),
  ).toBeVisible();

  // Mock test: start, answer one task right, finish, see the results.
  await openTab(page, "Пробники");
  await screenTitle(page, "Пробники");
  const mockCard = page.locator("article", {
    has: page.getByRole("heading", { name: mock.mock.title }),
  });
  await mockCard.getByRole("button", { name: "Начать пробник" }).click();
  const dialog = page.getByRole("dialog", { name: "Готов к пробнику?" });
  await expect(dialog).toContainText(`${mock.tasks.length} задани`);
  await expect(dialog).toContainText(`${mock.mock.minutes} минут`);
  await dialog.getByRole("button", { name: "Начать" }).click();
  const timer = page.getByRole("timer");
  await expect(timer).toBeVisible();
  const left = timerSeconds((await timer.textContent()) ?? "");
  expect(left).toBeGreaterThan(mock.mock.minutes * 60 - 120);
  expect(left).toBeLessThanOrEqual(mock.mock.minutes * 60 + 3);
  if (mock.taskIndex > 0)
    await page.getByRole("button", { name: `Задание ${mock.taskIndex + 1}, без ответа` }).click();
  await page.getByRole("textbox", { name: "Твой ответ" }).fill(mock.task.answer ?? "");
  await expect(page.getByText(`Отвечено 1 из ${mock.tasks.length}`)).toBeVisible();
  await page.getByRole("button", { name: "Завершить", exact: true }).first().click();
  const confirm = page.getByRole("dialog", { name: "Завершить пробник?" });
  await expect(confirm).toContainText(`Отвечено 1 из ${mock.tasks.length}`);
  await confirm.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByText("Результат пробника")).toBeVisible();
  const points = mock.task.points ?? 1;
  await expect(page.locator(".ol-result-score b")).toHaveText(String(points));
  await expect(page.locator(".ol-result-score")).toContainText(`из ${mock.maxScore}`);
  await expect(page.getByRole("button", { name: "Разобрать ошибки" })).toBeVisible();

  // Profile stats reflect everything.
  await openTab(page, "Я");
  await screenTitle(page, "Я");
  const stats = page.locator(".ol-stats");
  await expect(stats).toContainText("1звезда за темы");
  await expect(stats).toContainText("1задача решена");
  await expect(
    page.locator("section", { has: page.getByRole("heading", { name: /История пробников/ }) }),
  ).toContainText(`${points} из ${mock.maxScore}`);
});
