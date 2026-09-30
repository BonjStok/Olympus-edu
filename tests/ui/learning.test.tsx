import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toApiError } from "@/lib/client/api";
import { freezeDate, heading, lessons, renderApp, tasks, topic } from "../support/render-app";

beforeEach(() => freezeDate());
afterEach(() => vi.useRealTimers());

describe("theory", () => {
  it("counts a lesson on «Дальше» and gives the theory star automatically at the end", async () => {
    const { user, api } = renderApp({ hash: "#/learn" });
    await heading("Учёба");
    // The recommended topic is highlighted.
    const next = screen.getByRole("heading", { level: 2, name: topic.title });
    await user.click(
      within(next.closest("section") as HTMLElement).getByRole("button", { name: "Начать" }),
    );
    await heading(topic.title);
    expect(await screen.findByText("Текст урока 1")).toBeInTheDocument();
    // Opening a lesson does not count it as read.
    expect(api.calls.some((c) => c.action === "view-lesson")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Дальше" }));
    expect(await screen.findByText("Текст урока 2")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.action === "view-lesson").map((c) => c.payload.id)).toEqual([
      "math-5-01-l1",
    ]);
    expect(screen.getByRole("button", { name: "Урок 1, прочитан" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Завершить теорию" }));
    expect(await screen.findByText("Теория пройдена!")).toBeInTheDocument();
    await waitFor(() => expect(api.calls.some((c) => c.action === "star")).toBe(true));
    expect(screen.getByText("Звезда за теорию! ⭐")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "К практике" }));
    expect(await screen.findByText("Сколько будет 2 + 1?")).toBeInTheDocument();
    expect(location.hash).toBe("#/learn/topic/math-5-01/practice/1");
  });
});

describe("theory star", () => {
  it("is claimed only after the server has stored the last lesson", async () => {
    const { user, api } = renderApp({
      hash: `#/learn/topic/${topic.id}/theory/2`,
      progress: { [`lesson:${lessons[0].id}`]: { read: true } },
      handlers: {
        star: () => {
          // The server's rule: every lesson of the topic must be stored as read.
          if (!lessons.every((l) => api.progress[`lesson:${l.id}`]))
            throw toApiError(409, {
              error: "Сначала открой все уроки темы",
              code: "LESSONS_NOT_READ",
            });
          return { ok: true };
        },
      },
    });
    const call = api.call.bind(api);
    api.call = (async (action: string, payload: Record<string, unknown>) => {
      // «Урок прочитан» is slow to reach the server.
      if (action === "view-lesson") await new Promise((r) => setTimeout(r, 150));
      return call(action as "view-lesson", payload as { id: string });
    }) as typeof api.call;
    await heading(topic.title);
    await user.click(await screen.findByRole("button", { name: "Завершить теорию" }));
    expect(
      await screen.findByText("Теория пройдена!", undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Сначала открой все уроки темы")).toBeNull();
  });
});

describe("practice", () => {
  it("checks answers: validation next to the field, wrong, then right", async () => {
    const { user, api } = renderApp({ hash: "#/learn/topic/math-5-01/practice/1" });
    await screen.findByText("Сколько будет 2 + 1?");
    const input = screen.getByRole("textbox", { name: "Твой ответ" });
    const check = screen.getByRole("button", { name: "Проверить" });

    await user.click(check);
    expect(screen.getByText("Сначала впиши ответ")).toBeInTheDocument();
    await user.type(input, "три");
    await user.click(check);
    expect(screen.getByText("Нужно число, например 12 или 0,5")).toBeInTheDocument();
    expect(api.calls.some((c) => c.action === "check")).toBe(false);

    await user.clear(input);
    await user.type(input, "4");
    await user.click(check);
    expect(
      await screen.findByText("Пока неверно. Попробуй ещё раз или возьми подсказку"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Задача 1, пока не решена" })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "3{Enter}");
    expect(await screen.findByText("Верно! Отличная работа")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Задача 1, решена" })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.action === "check").map((c) => c.payload.answer)).toEqual([
      "4",
      "3",
    ]);
  });

  it("asks before showing the solution and marks the task as solved after it", async () => {
    const { user, api } = renderApp({ hash: "#/learn/topic/math-5-01/practice/2" });
    await screen.findByText("Сколько будет 3 + 1?");
    await user.click(screen.getByRole("button", { name: "Подсказка" }));
    expect(await screen.findByText("Прибавь единицу")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Посмотреть решение" }));
    const dialog = await screen.findByRole("dialog", { name: "Точно открыть решение?" });
    expect(within(dialog).getByText(/не пойдёт в звёзды и медали/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Ещё подумаю" }));
    expect(api.calls.some((c) => c.action === "reveal")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Посмотреть решение" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Показать решение" }),
    );
    const solution = await screen.findByRole("region", { name: "Решение" });
    expect(within(solution).getByText("4")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Твой ответ" }), "4{Enter}");
    await screen.findByText("Верно! Отличная работа");
    expect(
      screen.getByRole("button", { name: "Задача 2, решена после разбора" }),
    ).toBeInTheDocument();
  });

  it("the third own solution gives a practice star and suggests the next topic", async () => {
    const solved = (id: string) => ({
      title: "t",
      topicId: topic.id,
      subject: "math",
      correct: true,
      lastCorrect: true,
      attempts: 1,
      selfChecked: false,
      id,
    });
    const { user } = renderApp({
      hash: "#/learn/topic/math-5-01/practice/4",
      progress: { [`task:${tasks[0].id}`]: solved("a"), [`task:${tasks[1].id}`]: solved("b") },
    });
    await screen.findByText("Сколько будет 5 + 1?");
    expect(
      screen.getByText("Реши ещё 1 задачу – и получишь звезду за практику"),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Твой ответ" }), "6{Enter}");
    expect(await screen.findByText("Тема закреплена!")).toBeInTheDocument();
    expect(screen.getByText("Следующая тема – «Остатки».")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Следующая тема" }));
    await heading("Остатки");
  });

  it("explains that the code checker is down and keeps the solution available", async () => {
    const codeTask = {
      ...tasks[0],
      id: "code-1",
      type: "code" as const,
      prompt: "Выведи сумму",
      example: { input: "1 2", output: "3" },
    };
    const { user } = renderApp({
      hash: "#/learn/topic/math-5-01/practice/1",
      records: [topic, { ...codeTask }],
      features: { runner: false },
    });
    await screen.findByText("Выведи сумму");
    expect(screen.getByText(/Проверка программ сейчас не работает/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Входные данные (можно изменить)" })).toHaveValue(
      "1 2",
    );
    const editor = screen.getByRole("textbox", { name: /Код программы/ });
    expect(editor).toHaveAttribute("autocapitalize", "off");
    await user.type(editor, "print(3)");
    expect(await screen.findByText("Код сохранён", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Посмотреть решение" })).toBeEnabled();
  });

  it("renders fenced code inside prompts", async () => {
    const t = { ...tasks[0], prompt: "Что выведет программа?\n```python\nprint(2 + 3)\n```" };
    renderApp({ hash: "#/learn/topic/math-5-01/practice/1", records: [topic, t] });
    const code = await screen.findByLabelText("Код программы");
    expect(code.tagName).toBe("PRE");
    expect(code).toHaveTextContent("print(2 + 3)");
  });
});
