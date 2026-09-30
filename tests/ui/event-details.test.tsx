// The olympiad screen shows the catalogue summary at once and loads the description, the
// «Проверено … · источник» line and the picture with the action `olympiad`.
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { freezeDate, heading, learningContent, olympiad, renderApp } from "../support/render-app";

beforeEach(() => freezeDate());
afterEach(() => vi.useRealTimers());

const TITLE = "Олимпиада «Бельчонок» – математика";
const DESCRIPTION = "Командная олимпиада для 4–6 классов: задачи на логику и смекалку.";

const full = olympiad({
  description: DESCRIPTION,
  source: "https://olimpiada.ru/activity/5372",
  verifiedAt: "2026-09-20",
  image: "https://example.ru/belchonok.png",
});
const other = olympiad({
  id: "olymp-2",
  title: "Турнир Ломоносова",
  description: "Многопредметный турнир.",
});
const records = [...learningContent, full, other];

function detailCalls(api: { calls: { action: string; payload: Record<string, unknown> }[] }) {
  return api.calls.filter((c) => c.action === "olympiad").map((c) => c.payload.id);
}

/** The in-app «‹ Олимпиады» link of the olympiad screen. */
function backLink(): HTMLElement {
  return screen
    .getAllByRole("button", { name: "Олимпиады" })
    .find((b) => b.classList.contains("ol-back")) as HTMLElement;
}

/** A promise the test resolves when it has looked at the loading state. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("olympiad details", () => {
  it("shows the summary at once, then the description, the source line and the picture", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const answer = gate();
    const { user, api } = renderApp({
      hash: "#/calendar/event/olymp",
      records,
      handlers: {
        olympiad: async (p) => {
          await answer.promise;
          return { olympiad: records.find((r) => r.id === p.id) };
        },
      },
    });
    await heading(TITLE);

    // Summary facts and actions are there while the details are still loading.
    expect(screen.getByText("Регистрация до 12 октября · осталось 13 дней")).toBeInTheDocument();
    expect(screen.getByText("Загружаем описание…")).toBeInTheDocument();
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
    expect(screen.queryByText(/Проверено/)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Зарегистрироваться на сайте" }));
    expect(open).toHaveBeenCalledWith("https://example.ru/reg", "_blank", "noopener,noreferrer");
    await user.click(screen.getByRole("button", { name: "Я участвую" }));
    expect(await screen.findByText("Ты участвуешь", { selector: "b" })).toBeInTheDocument();

    answer.open();
    expect(await screen.findByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.getByText(/Проверено 20 сентября/)).toHaveTextContent("источник: olimpiada.ru");
    expect(screen.getByRole("img", { name: `Картинка олимпиады «${TITLE}»` })).toHaveAttribute(
      "src",
      "https://example.ru/belchonok.png",
    );
    expect(screen.queryByText("Загружаем описание…")).toBeNull();
    expect(detailCalls(api)).toEqual(["olymp"]);
  });

  it("keeps loaded details for the session", async () => {
    const { user, api } = renderApp({ hash: "#/calendar/event/olymp", records });
    await heading(TITLE);
    expect(await screen.findByText(DESCRIPTION)).toBeInTheDocument();

    await user.click(backLink());
    await heading("Олимпиады");
    await user.click(screen.getByRole("button", { name: /Олимпиада «Бельчонок»/ }));
    await heading(TITLE);
    // Shown right away from the cache, without a second request.
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText("Загружаем описание…")).toBeNull();
    expect(detailCalls(api)).toEqual(["olymp"]);
  });

  it("shows a failed load calmly with a retry and keeps the rest of the screen working", async () => {
    const { user, api } = renderApp({ hash: "#/calendar/event/olymp", records });
    api.failNext(
      "olympiad",
      new ApiError(0, "NETWORK", "Нет связи с сервером. Проверь интернет и нажми «Повторить»"),
    );
    await heading(TITLE);
    expect(await screen.findByText(/Описание не загрузилось/)).toHaveTextContent(
      "Нет связи с сервером",
    );
    // Not an alarm: no alert, no toast; registration still works.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Проверено/)).toBeNull();
    expect(screen.getByRole("button", { name: "Зарегистрироваться на сайте" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Я участвую" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Попробовать ещё раз" }));
    expect(await screen.findByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(/Описание не загрузилось/)).toBeNull();
    expect(screen.getByText(/Проверено 20 сентября/)).toBeInTheDocument();
    expect(detailCalls(api)).toEqual(["olymp", "olymp"]);
  });

  it("older server with complete olympiads in the catalogue: shows them, asks nothing", async () => {
    const { api } = renderApp({ hash: "#/calendar/event/olymp", records, legacy: true });
    await heading(TITLE);
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(screen.getByText(/Проверено 20 сентября/)).toBeInTheDocument();
    expect(detailCalls(api)).toEqual([]);
  });

  it("server without the action: no description, no error, asked only once", async () => {
    const { user, api } = renderApp({
      hash: "#/calendar/event/olymp",
      records,
      handlers: {
        olympiad: () => {
          throw new ApiError(400, "UNKNOWN_ACTION", "Неизвестное действие");
        },
      },
    });
    await heading(TITLE);
    await waitFor(() => expect(detailCalls(api)).toEqual(["olymp"]));
    await waitFor(() => expect(screen.queryByText("Загружаем описание…")).toBeNull());
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
    expect(screen.queryByText(/Описание не загрузилось/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Я участвую" })).toBeEnabled();

    // Another olympiad: the app already knows the server cannot send details.
    await user.click(backLink());
    await heading("Олимпиады");
    await user.click(screen.getByRole("button", { name: /Турнир Ломоносова/ }));
    await heading("Турнир Ломоносова");
    await waitFor(() => expect(screen.queryByText("Загружаем описание…")).toBeNull());
    expect(detailCalls(api)).toEqual(["olymp"]);
  });
});
