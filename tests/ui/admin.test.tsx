import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentRecord, MockTest, Olympiad } from "@/lib/domain/types";
import { toApiError } from "@/lib/client/api";
import {
  freezeDate,
  heading,
  learningContent,
  mock,
  olympiad,
  renderApp,
  tasks,
} from "../support/render-app";

beforeEach(() => freezeDate());
afterEach(() => vi.useRealTimers());

/** A teacher session with a publish endpoint that records what was sent. */
function renderEditor(hash: string, records: ContentRecord[]) {
  const published: ContentRecord[] = [];
  const utils = renderApp({
    hash,
    records,
    profile: { admin: true },
    handlers: {
      publish: (p) => {
        published.push(p.record as ContentRecord);
        return { ok: true, count: 1 };
      },
    },
  });
  return { ...utils, published };
}

describe("teacher's editor", () => {
  it("publishes an offline olympiad for the whole country", async () => {
    const kangaroo = olympiad({
      id: "kangaroo",
      title: "Кенгуру",
      format: "offline",
      region: "",
      date: "2027-03-18",
      deadline: "expected",
    });
    const { user, published } = renderEditor("#/admin/olympiads/edit/olympiads/kangaroo", [
      ...learningContent,
      kangaroo,
    ]);
    await heading("Кенгуру");
    expect(screen.getByRole("radio", { name: "Вся Россия" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    await waitFor(() => expect(published).toHaveLength(1), { timeout: 3000 });
    expect(published[0]).toMatchObject({ format: "offline", region: "" });
  });

  it("accepts a registration deadline inside a multi-day olympiad", async () => {
    const windowed = olympiad({
      id: "window",
      date: "2026-10-20",
      dateEnd: "2026-11-10",
      deadline: "2026-11-01",
    });
    const { user, published } = renderEditor("#/admin/olympiads/edit/olympiads/window", [
      ...learningContent,
      windowed,
    ]);
    await heading(windowed.title);
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    await waitFor(() => expect(published).toHaveLength(1), { timeout: 3000 });
    expect(published[0]).toMatchObject({ deadline: "2026-11-01", dateEnd: "2026-11-10" });
  });

  it("names a deleted task of a mock and lets the teacher remove it", async () => {
    const withGone: MockTest = { ...mock, taskIds: [tasks[0].id, "gone-task"] };
    const { user, published } = renderEditor(`#/admin/mock-tests/edit/mock-tests/${mock.id}`, [
      ...learningContent.filter((r) => r.id !== mock.id),
      withGone,
    ]);
    await heading(mock.title);
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    expect(
      (
        await screen.findAllByText(
          "Задание «gone-task» удалено – уберите его из пробника или восстановите в «Удалённых»",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(published).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Убрать" }));
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    await waitFor(() => expect(published).toHaveLength(1), { timeout: 3000 });
    expect((published[0] as MockTest).taskIds).toEqual([tasks[0].id]);
  });

  it("shows the server's rule at its field", async () => {
    const o = olympiad({ id: "srv" });
    const { user } = renderApp({
      hash: "#/admin/olympiads/edit/olympiads/srv",
      records: [...learningContent, o],
      profile: { admin: true },
      handlers: {
        publish: () => {
          throw toApiError(400, {
            error: "srv: Дедлайн регистрации не может быть позже окончания олимпиады",
            code: "VALIDATION_ERROR",
          });
        },
      },
    });
    await heading(o.title);
    await user.click(screen.getByRole("button", { name: "Опубликовать" }));
    const error = await screen.findByText(
      "Дедлайн регистрации не может быть позже окончания олимпиады",
    );
    expect(error.closest("[data-field]")).toHaveAttribute("data-field", "deadline");
  });

  it("downloads what children see, and drafts only on request", async () => {
    const draft = { ...olympiad({ id: "o1", title: "Черновое название" }) };
    const published = { ...olympiad({ id: "o1", title: "Опубликованное название" }), draft };
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:x"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const { user } = renderApp({
      hash: "#/admin/olympiads",
      records: [...learningContent, published as unknown as Olympiad],
      profile: { admin: true },
    });
    await heading("Олимпиады");
    await user.click(screen.getByRole("button", { name: "Скачать опубликованное" }));
    const [first] = JSON.parse(await blobs[0].text()) as Olympiad[];
    expect(first.title).toBe("Опубликованное название");
    expect(first).not.toHaveProperty("draft");
    await user.click(screen.getByRole("button", { name: "Скачать черновики (1)" }));
    const [second] = JSON.parse(await blobs[1].text()) as Olympiad[];
    expect(second.title).toBe("Черновое название");
  });
});

describe("olympiad picture", () => {
  it("is shown on the olympiad screen", async () => {
    renderApp({
      hash: "#/calendar/event/pic",
      records: [
        ...learningContent,
        olympiad({ id: "pic", image: "https://example.ru/poster.webp" }),
      ],
    });
    await heading("Олимпиада «Бельчонок» – математика");
    // The picture comes with the olympiad details (action `olympiad`), after the summary.
    const img = await screen.findByRole("img", {
      name: "Картинка олимпиады «Олимпиада «Бельчонок» – математика»",
    });
    expect(img).toHaveAttribute("src", "https://example.ru/poster.webp");
    expect(img).toHaveAttribute("loading", "lazy");
  });
});
