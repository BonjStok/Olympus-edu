import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockAttempt } from "@/lib/domain/types";
import { toApiError } from "@/lib/client/api";
import { heading, mock, renderApp, tasks } from "../support/render-app";

afterEach(() => vi.useRealTimers());

describe("mock tests", () => {
  it("start → answer → finish → results", async () => {
    const { user, api } = renderApp({ hash: "#/mocks" });
    await heading("Пробники");
    await user.click(screen.getByRole("button", { name: "Начать пробник" }));
    const dialog = await screen.findByRole("dialog", { name: "Готов к пробнику?" });
    expect(within(dialog).getByText(/2 задания · 40 минут/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Начать" }));

    expect(await screen.findByRole("timer")).toHaveTextContent(/(3\d|40):\d\d/);
    // Generic task titles are hidden: the child sees «Задание 1 из 2».
    expect(screen.getByText(/Задание 1 из 2/)).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Твой ответ" });
    await user.type(input, "abc");
    expect(screen.getByText(/Нужно число/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "3");
    await user.click(screen.getByRole("button", { name: "Дальше" }));
    await user.type(screen.getByRole("textbox", { name: "Твой ответ" }), "5");
    expect(screen.getByText("Отвечено 2 из 2")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Завершить" })[0]);
    const confirm = await screen.findByRole("dialog", { name: "Завершить пробник?" });
    await user.click(within(confirm).getByRole("button", { name: "Завершить" }));

    expect(await screen.findByText(/из 2 баллов/)).toBeInTheDocument();
    expect(screen.getByText("Результат пробника")).toBeInTheDocument();
    const finish = api.calls.find((c) => c.action === "finish-mock");
    expect(finish?.payload.answers).toEqual({ [tasks[0].id]: "3", [tasks[1].id]: "5" });
    expect(screen.getAllByText("Верно").length + screen.getAllByText("Неверно").length).toBe(2);
    expect(screen.getByRole("button", { name: "Разобрать ошибки" })).toBeInTheDocument();
  });

  it("continuing re-reads the attempt from the server and keeps earlier answers", async () => {
    const attempt: MockAttempt = {
      id: "att-1",
      testId: mock.id,
      title: mock.title,
      subject: "math",
      started: Date.now() - 60_000,
      ends: Date.now() + 30 * 60_000,
      tasks: [tasks[0], tasks[1]].map(({ answer: _a, solution: _s, hint: _h, ...t }) => t),
      answers: {},
      finished: false,
    };
    // The bootstrap copy is stale (no answers) – the server copy has one.
    const { user, api } = renderApp({
      hash: "#/mocks",
      progress: { [`attempt:${attempt.id}`]: attempt },
      handlers: {
        "mock-get": () => ({ attempt: { ...attempt, answers: { [tasks[0].id]: "111" } } }),
      },
    });
    await heading("Пробники");
    expect(screen.getByText(/Идёт попытка · осталось/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Продолжить" }));
    // Opens on the first unanswered task; the answered one is marked.
    expect(
      await screen.findByRole("button", { name: "Задание 1, есть ответ" }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Твой ответ" }), "222");
    await waitFor(() => expect(api.calls.some((c) => c.action === "mock-save")).toBe(true), {
      timeout: 2000,
    });
    // Only the changed answer is sent to a merging server.
    expect(api.calls.find((c) => c.action === "mock-save")?.payload.answers).toEqual({
      [tasks[1].id]: "222",
    });
  });

  it("finishes automatically when the time is up", async () => {
    const attempt: MockAttempt = {
      id: "att-2",
      testId: mock.id,
      title: mock.title,
      subject: "math",
      started: Date.now() - 60_000,
      ends: Date.now() + 2500,
      tasks: [tasks[0]].map(({ answer: _a, solution: _s, hint: _h, ...t }) => t),
      answers: { [tasks[0].id]: "3" },
      finished: false,
    };
    const { api } = renderApp({
      hash: "#/mocks/attempt/att-2",
      progress: { [`attempt:${attempt.id}`]: attempt },
    });
    expect(await screen.findByRole("timer")).toBeInTheDocument();
    await waitFor(() => expect(api.calls.some((c) => c.action === "finish-mock")).toBe(true), {
      timeout: 5000,
    });
    expect(
      await screen.findByText("Время вышло – пробник завершён. Смотри результат"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/из 1 балла/).length).toBeGreaterThan(0);
  });

  it("shows the results when an autosave finds the attempt already finished", async () => {
    const running: MockAttempt = {
      id: "att-4",
      testId: mock.id,
      title: mock.title,
      subject: "math",
      started: Date.now() - 60_000,
      ends: Date.now() + 30 * 60_000,
      tasks: [tasks[0]].map(({ answer: _a, solution: _s, hint: _h, ...t }) => t),
      answers: {},
      finished: false,
    };
    // The server never answers «already finished» with an error: it returns the attempt.
    const finished: MockAttempt = {
      ...running,
      tasks: [tasks[0]],
      answers: { [tasks[0].id]: "3" },
      finished: true,
      finishedAt: Date.now(),
      results: [{ id: tasks[0].id, correct: true, points: 1, max: 1, note: "", status: "correct" }],
      score: 1,
      max: 1,
    };
    const { user } = renderApp({
      hash: "#/mocks/attempt/att-4",
      progress: { [`attempt:${running.id}`]: running },
      handlers: { "mock-save": () => ({ attempt: finished }) },
    });
    await user.type(await screen.findByRole("textbox", { name: "Твой ответ" }), "3");
    expect(
      await screen.findByText("Время вышло – пробник завершён. Смотри результат", undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Результат пробника")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).toBeNull();
  });

  it("offers the list of mocks when the attempt is gone", async () => {
    const { user } = renderApp({
      hash: "#/mocks/attempt/lost",
      handlers: {
        "mock-get": () => {
          throw toApiError(404, { error: "Попытка не найдена", code: "ATTEMPT_NOT_FOUND" });
        },
      },
    });
    expect(await screen.findByText("Попытка не найдена")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Попробовать ещё раз" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "К пробникам" }));
    await heading("Пробники");
  });

  it("asks before leaving a running mock and asks MAX to confirm closing", async () => {
    const wa = {
      initData: "query_id=1",
      platform: "ios" as const,
      enableClosingConfirmation: vi.fn(),
      disableClosingConfirmation: vi.fn(),
      BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
    };
    window.WebApp = wa;
    const attempt: MockAttempt = {
      id: "att-3",
      testId: mock.id,
      title: mock.title,
      subject: "math",
      started: Date.now(),
      ends: Date.now() + 30 * 60_000,
      tasks: [tasks[0]].map(({ answer: _a, solution: _s, hint: _h, ...t }) => t),
      answers: {},
      finished: false,
    };
    const { user } = renderApp({
      hash: "#/mocks/attempt/att-3",
      progress: { [`attempt:${attempt.id}`]: attempt },
    });
    expect(await screen.findByRole("timer")).toBeInTheDocument();
    expect(wa.enableClosingConfirmation).toHaveBeenCalled();
    expect(wa.BackButton.show).toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "Олимпиады" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Выйти из пробника?" });
    await user.click(within(dialog).getByRole("button", { name: "Остаться" }));
    expect(screen.getByRole("timer")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Олимпиады" })[0]);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Выйти" }),
    );
    await heading("Олимпиады");
    expect(wa.disableClosingConfirmation).toHaveBeenCalled();
    // The running mock stays visible on every screen.
    expect(screen.getByText(/Идёт пробник/)).toBeInTheDocument();
  });
});
