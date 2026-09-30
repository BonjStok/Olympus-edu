import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { freezeDate, heading, learningContent, olympiad, renderApp } from "../support/render-app";

beforeEach(() => freezeDate());
afterEach(() => vi.useRealTimers());

describe("navigation", () => {
  it("browser Back returns to the previous screen instead of leaving the app", async () => {
    const { user } = renderApp({ hash: "#/calendar", records: [...learningContent, olympiad({})] });
    await heading("Олимпиады");
    await user.click(screen.getByRole("button", { name: /Олимпиада «Бельчонок»/ }));
    await heading("Олимпиада «Бельчонок» – математика");
    expect(location.hash).toBe("#/calendar/event/olymp");
    history.back();
    await heading("Олимпиады");
    expect(location.hash).toBe("#/calendar");
  });

  it("the in-app back link and tabs work, the current tab is marked", async () => {
    const { user } = renderApp({
      hash: "#/calendar/event/olymp",
      records: [...learningContent, olympiad({})],
    });
    await heading("Олимпиада «Бельчонок» – математика");
    const back = screen
      .getAllByRole("button", { name: "Олимпиады" })
      .find((b) => b.classList.contains("ol-back")) as HTMLElement;
    await user.click(back);
    await heading("Олимпиады");
    const tab = screen.getAllByRole("button", { name: "Учёба" })[0];
    await user.click(tab);
    await heading("Учёба");
    expect(screen.getAllByRole("button", { name: "Учёба" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("MAX BackButton appears on nested screens and goes back", async () => {
    let onBack: (() => void) | undefined;
    window.WebApp = {
      initData: "",
      platform: "android",
      ready: vi.fn(),
      BackButton: {
        show: vi.fn(),
        hide: vi.fn(),
        onClick: vi.fn((cb: () => void) => (onBack = cb)),
        offClick: vi.fn(),
      },
    };
    renderApp({ hash: "#/calendar/event/olymp", records: [...learningContent, olympiad({})] });
    await heading("Олимпиада «Бельчонок» – математика");
    // Effects run right after the screen is painted: wait for them instead of racing them.
    await waitFor(() => expect(window.WebApp?.BackButton?.show).toHaveBeenCalled());
    await waitFor(() => expect(window.WebApp?.ready).toHaveBeenCalledTimes(1));
    onBack?.();
    await heading("Олимпиады");
    await waitFor(() => expect(window.WebApp?.BackButton?.hide).toHaveBeenCalled());
  });
});

describe("deep links from MAX", () => {
  it("event_<id> opens the olympiad and loads its description", async () => {
    window.WebApp = {
      initData: "query_id=1",
      initDataUnsafe: { start_param: "event_olymp" },
      platform: "android",
    };
    const { api } = renderApp({
      records: [...learningContent, olympiad({ description: "Олимпиада для всей семьи" })],
    });
    await heading("Олимпиада «Бельчонок» – математика");
    // MAX sign-in happened before loading data.
    expect(api.calls[0].action).toBe("session");
    expect(await screen.findByText("Олимпиада для всей семьи")).toBeInTheDocument();
    expect(api.calls.find((c) => c.action === "olympiad")?.payload).toEqual({ id: "olymp" });
  });

  it("tab_training opens «Учёба»; unknown ids explain themselves", async () => {
    window.WebApp = {
      initData: "q",
      initDataUnsafe: { start_param: "tab_training" },
      platform: "ios",
    };
    renderApp();
    await heading("Учёба");
  });

  it("an unknown olympiad shows a friendly message", async () => {
    window.WebApp = {
      initData: "q",
      initDataUnsafe: { start_param: "event_gone" },
      platform: "ios",
    };
    renderApp();
    await heading("Олимпиады");
    expect(
      screen.getByText("Этой олимпиады уже нет в календаре. Посмотри другие"),
    ).toBeInTheDocument();
  });

  it("mock_<id> opens the start dialog of that mock", async () => {
    window.WebApp = {
      initData: "q",
      initDataUnsafe: { start_param: "mock_mock-5-math" },
      platform: "ios",
    };
    renderApp();
    expect(await screen.findByRole("dialog", { name: "Готов к пробнику?" })).toBeInTheDocument();
  });
});

describe("loading, errors and first run", () => {
  it("bootstrap failure → error banner → retry works", async () => {
    const { createFakeApi } = await import("../support/fake-api");
    const { render } = await import("@testing-library/react");
    const { App } = await import("@/components/olympus/App");
    const userEvent = (await import("@testing-library/user-event")).default;
    localStorage.setItem(
      "olympus.settings",
      JSON.stringify({ onboarded: true, grade: 5, subject: "math" }),
    );
    const api = createFakeApi({ records: learningContent });
    api.failNext(
      "bootstrap",
      new ApiError(0, "NETWORK", "Нет связи с сервером. Проверь интернет и нажми «Повторить»"),
    );
    render(<App api={api} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Не получилось загрузить Олимпус")).toBeInTheDocument();
    expect(
      within(alert).getByText("Нет связи с сервером. Проверь интернет и нажми «Повторить»"),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(alert).getByRole("button", { name: "Попробовать ещё раз" }));
    await heading(/Привет/);
  });

  it("first run asks class, subject and region, then opens «Главная»", async () => {
    const { user, api } = renderApp({ settings: null });
    expect(await screen.findByRole("heading", { name: "Привет! Я Олимпус" })).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Выбери класс и предмет" });
    expect(start).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "5 класс" }));
    await user.click(screen.getByRole("radio", { name: "Обе" }));
    await user.click(screen.getByRole("button", { name: "Начать" }));
    await heading("Привет!");
    expect(screen.getByRole("button", { name: /5 класс · Оба предмета/ })).toBeInTheDocument();
    expect(api.calls.find((c) => c.action === "settings")?.payload).toMatchObject({ grade: 5 });
  });

  it("guest profile explains what is saved and how MAX sign-in works", async () => {
    renderApp({ hash: "#/profile", features: { max: true } });
    await heading("Я");
    expect(screen.getByRole("heading", { name: "Ты занимаешься как гость" })).toBeInTheDocument();
    expect(screen.getByText(/Открой Олимпус в MAX – вход произойдёт сам/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Для учителя" })).toBeInTheDocument();
  });
});
