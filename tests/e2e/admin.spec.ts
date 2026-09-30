/**
 * Teacher smoke test: sign in, create and publish a topic, see it as a child, clean up.
 */
import { expect, test } from "@playwright/test";
import { openTab, prepare, presetLearner, screenTitle } from "./helpers";

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "local-admin-pass";

test("a teacher publishes a topic and a child sees it", async ({ context, page }, info) => {
  test.setTimeout(90_000);
  await prepare(context);
  await presetLearner(context, { grade: 6, subject: "math" });
  const title = `Тема E2E ${info.project.name} ${Date.now()}`;

  // The teacher's entry is in the profile, not in the child's face.
  await page.goto("/#/profile");
  await screenTitle(page, "Я");
  await page.getByRole("button", { name: "Для учителя" }).click();
  await screenTitle(page, "Вход");

  // Wrong password: the error is next to the field.
  await page.getByLabel("Пароль учителя").fill("wrong-password");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText(/Пароль не подошёл/)).toBeVisible();

  await page.getByLabel("Пароль учителя").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await screenTitle(page, "Олимпиады");
  await expect(page.locator(".ol-tabbar")).toBeHidden();

  // Create a topic: publishing an empty form shows the error at the field.
  await page.getByRole("radio", { name: "Темы" }).click();
  await screenTitle(page, "Темы");
  await page.getByRole("button", { name: "Добавить тему" }).click();
  await screenTitle(page, "Новая тема");
  await page.getByRole("button", { name: "Опубликовать" }).click();
  await expect(page.getByText("Впишите название")).toBeVisible();
  await page.getByLabel("Название").fill(title);
  await page.getByRole("radio", { name: "6 класс" }).click();
  await page.getByLabel("Номер по порядку").fill("99");
  await page.getByRole("button", { name: "Опубликовать" }).click();
  await expect(page.getByText(`Опубликовано: «${title}». Дети уже видят изменения`)).toBeVisible();
  await screenTitle(page, "Темы");
  await expect(page.getByText(title)).toBeVisible();

  // Leave the teacher's mode and look as a child.
  await page.getByRole("button", { name: "Выйти" }).click();
  await screenTitle(page, "Я");
  await openTab(page, "Учёба");
  await screenTitle(page, "Учёба");
  await page.getByRole("textbox", { name: "Найти тему" }).fill("E2E");
  await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();

  // Clean up.
  await page.goto("/#/admin/topics");
  await page.getByLabel("Пароль учителя").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await screenTitle(page, "Темы");
  await page.getByRole("textbox", { name: "Найти материал" }).fill(title);
  await page.getByRole("button", { name: `Удалить: ${title}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByText(`«${title}» удалено. Вернуть можно из корзины`)).toBeVisible();
  await page.getByRole("button", { name: "Выйти" }).click();
});
