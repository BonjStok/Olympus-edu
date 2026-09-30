import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Olympiad } from "@/lib/domain/types";
import v2 from "../fixtures/olympiads.v2.sample.json";
import { freezeDate, heading, learningContent, olympiad, renderApp } from "../support/render-app";

const PROD = v2 as unknown as Olympiad[];

beforeEach(() => freezeDate());
afterEach(() => vi.useRealTimers());

function cards() {
  return screen.queryAllByRole("article");
}

describe("calendar", () => {
  it("collapses regional editions and narrows down to the chosen region", async () => {
    const { user, api } = renderApp({
      hash: "#/calendar",
      records: [...learningContent, ...PROD],
      settings: { onboarded: true, grade: 5, subject: "math" },
    });
    await heading("Олимпиады");

    // No region: ВсОШ math is one card with «Выбрать регион», not 87.
    const vsosh = screen.getAllByRole("heading", { name: "ВсОШ – математика" });
    expect(vsosh).toHaveLength(1);
    const card = vsosh[0].closest("article") as HTMLElement;
    expect(within(card).getByText(/в 86 регионах/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Выбрать регион" })).toBeInTheDocument();
    expect(screen.queryAllByText("ВсОШ – математика – школьный этап")).toHaveLength(0);

    // The friendly first-visit picker: choose a region by typing.
    const input = screen.getByRole("combobox", { name: "Твой регион" });
    await user.click(input);
    expect(
      within(screen.getByRole("listbox", { name: "Твой регион" })).getAllByRole("option").length,
    ).toBeGreaterThan(80);
    await user.type(input, "Моск");
    await user.click(screen.getByRole("option", { name: "Москва" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Показаны: 5 класс · математика · Москва и вся Россия/),
      ).toBeInTheDocument(),
    );
    // Now the Moscow edition is a regular card and the series card is gone.
    expect(screen.queryByRole("button", { name: "Выбрать регион" })).toBeNull();
    expect(screen.getByText("ВсОШ – математика – школьный этап")).toBeInTheDocument();
    for (const c of cards()) expect(c.textContent).not.toMatch(/Псковская|Татарстан|Алтай/);

    // The choice is remembered.
    expect(JSON.parse(localStorage.getItem("olympus.settings") ?? "{}").region).toBe("Москва");
    expect(api.calls.some((c) => c.action === "settings" && c.payload.region === "Москва")).toBe(
      true,
    );
  });

  it("works with the old server that has no settings action", async () => {
    const { user, api } = renderApp({
      hash: "#/calendar",
      legacy: true,
      records: [
        ...learningContent,
        olympiad({ id: "msk", region: "Москва", title: "Московская олимпиада" }),
      ],
    });
    await heading("Олимпиады");
    const input = screen.getByRole("combobox", { name: "Твой регион" });
    await user.type(input, "мск");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Московская олимпиада")).toBeInTheDocument());
    expect(api.calls.some((c) => c.action === "settings")).toBe(true);
    // No error toast for the unknown action.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(localStorage.getItem("olympus.settings") ?? "{}").region).toBe("Москва");
  });

  it("reopening the region list shows every region; typing filters; × resets", async () => {
    const { user } = renderApp({
      hash: "#/calendar",
      settings: { onboarded: true, grade: 5, subject: "math", region: "Псковская область" },
      records: [...learningContent, olympiad({})],
    });
    await heading("Олимпиады");
    await user.click(screen.getByRole("button", { name: "Фильтры" }));
    const input = screen.getByRole("combobox", { name: "Регион" });
    expect(input).toHaveValue("Псковская область");
    await user.click(input);
    const list = screen.getByRole("listbox", { name: "Регион" });
    const options = within(list).getAllByRole("option");
    expect(options.length).toBeGreaterThan(80); // not collapsed to the chosen one
    expect(within(list).getByRole("option", { name: "Псковская область" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.type(input, "тыв");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Республика Тыва"]);
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("Псковская область");
    await user.click(screen.getByRole("button", { name: "Сбросить регион" }));
    expect(input).toHaveValue("");
    expect(screen.getByText(/Показаны: .*все регионы/)).toBeInTheDocument();
  });

  it("puts open registration first and hides closed and past olympiads until asked", async () => {
    const { user } = renderApp({
      hash: "#/calendar",
      settings: { onboarded: true, grade: 5, subject: "math", region: "Москва" },
      records: [
        ...learningContent,
        olympiad({
          id: "past",
          title: "Прошедшая олимпиада",
          date: "2026-09-10",
          deadline: "2026-09-01",
        }),
        olympiad({ id: "closed", title: "Закрытая регистрация", deadline: "2026-09-20" }),
        olympiad({ id: "open", title: "Открытая олимпиада", deadline: "2026-10-12" }),
      ],
    });
    await heading("Олимпиады");
    // The top of the list is painted first, the rest (here: collapsed sections) right after.
    await screen.findByRole("button", { name: /Прошедшие/ });
    const sections = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(sections.findIndex((t) => t?.startsWith("Можно зарегистрироваться"))).toBeLessThan(
      sections.findIndex((t) => t?.startsWith("Регистрация закрыта")),
    );
    expect(screen.getByText("Открытая олимпиада")).toBeInTheDocument();
    expect(screen.getByText("Регистрация до 12 октября · осталось 13 дней")).toBeInTheDocument();
    expect(screen.queryByText("Закрытая регистрация")).toBeNull();
    expect(screen.queryByText("Прошедшая олимпиада")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Прошедшие/ }));
    expect(screen.getByText("Прошедшая олимпиада")).toBeInTheDocument();
  });

  it("school registration: «Как участвовать», explanation and «Я участвую»", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { user, api } = renderApp({
      hash: "#/calendar/event/school",
      records: [
        ...learningContent,
        olympiad({
          id: "school",
          title: "ВсОШ – математика – школьный этап",
          region: "Москва",
          registrationType: "school",
          deadline: undefined,
          url: "https://siriusolymp.ru",
          source: "https://xn--h1aamv.xn--p1ai/news/",
          verifiedAt: "2026-09-29",
        }),
      ],
    });
    await heading("ВсОШ – математика – школьный этап");
    expect(
      screen.getAllByText(/Записывает школа – спроси учителя или классного руководителя/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Регистрация до/)).toBeNull();
    // The source line comes with the details (action `olympiad`), after the summary.
    expect(await screen.findByText(/Проверено 29 сентября/)).toHaveTextContent("источник: тиим.рф");

    await user.click(screen.getByRole("button", { name: "Как участвовать" }));
    expect(open).toHaveBeenCalledWith("https://siriusolymp.ru", "_blank", "noopener,noreferrer");

    await user.click(screen.getByRole("button", { name: "Я участвую" }));
    await waitFor(() =>
      expect(
        screen.getByText("Олимпиада сохранена в профиле. Удачи – и не забудь подготовиться!"),
      ).toBeInTheDocument(),
    );
    expect(api.calls.find((c) => c.action === "register")?.payload).toEqual({
      id: "school",
      yes: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Готово! Олимпиада в твоём профиле и на главной",
    );
  });

  it("link registration asks «Получилось?» after returning from the site", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { user, api } = renderApp({
      hash: "#/calendar/event/olymp",
      records: [...learningContent, olympiad({})],
    });
    await heading("Олимпиада «Бельчонок» – математика");
    await user.click(screen.getByRole("button", { name: "Зарегистрироваться на сайте" }));
    // Coming back to the app:
    window.dispatchEvent(new Event("focus"));
    await user.click(await screen.findByRole("button", { name: "Ещё нет" }));
    expect(
      screen.getByText("Хорошо! Вернуться к регистрации можно в любой момент."),
    ).toBeInTheDocument();
    expect(api.calls.some((c) => c.action === "register")).toBe(false);
  });

  it("shows an error next to the button when registration fails, and keeps the state", async () => {
    const { user, api } = renderApp({
      hash: "#/calendar/event/olymp",
      records: [...learningContent, olympiad({})],
    });
    await heading("Олимпиада «Бельчонок» – математика");
    const { ApiError } = await import("@/lib/client/api");
    api.failNext(
      "register",
      new ApiError(0, "NETWORK", "Нет связи с сервером. Проверь интернет и нажми «Повторить»"),
    );
    await user.click(screen.getByRole("button", { name: "Я участвую" }));
    expect(
      await screen.findByText("Нет связи с сервером. Проверь интернет и нажми «Повторить»"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ты участвуешь")).toBeNull();
  });

  it("«Я участвую» then «Убрать отметку» on a slow network ends unregistered", async () => {
    const { user, api } = renderApp({
      hash: "#/calendar/event/olymp",
      records: [...learningContent, olympiad({})],
    });
    await heading("Олимпиада «Бельчонок» – математика");
    // The first answer is slow; the second one would come back first without ordering.
    const call = api.call.bind(api);
    let slow = true;
    api.call = (async (action: string, payload: Record<string, unknown>) => {
      if (action === "register" && slow) {
        slow = false;
        await new Promise((r) => setTimeout(r, 150));
      }
      return call(action as "register", payload as { id: string; yes: boolean });
    }) as typeof api.call;
    await user.click(screen.getByRole("button", { name: "Я участвую" }));
    await user.click(await screen.findByRole("button", { name: "Убрать отметку" }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.action === "register").map((c) => c.payload.yes)).toEqual([
        true,
        false,
      ]),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByRole("button", { name: "Я участвую" })).toBeInTheDocument();
    expect(screen.queryByText("Ты участвуешь")).toBeNull();
    expect(api.progress["registration:olymp"]).toBeUndefined();
  });
});
