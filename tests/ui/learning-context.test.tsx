import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, Topic } from "@/lib/domain/types";
import { localStore } from "@/lib/client/storage";
import { freezeDate, heading, learningContent, renderApp, topic } from "../support/render-app";

const infoTopic: Topic = {
  ...topic,
  id: "info-5-01",
  subject: "info",
  title: "Алгоритмы и программы",
};
const math4Topic: Topic = {
  ...topic,
  id: "math-4-01",
  grade: 4,
  title: "Чётность чисел",
};
const infoTask: Task = {
  id: "info-5-01-task-1",
  kind: "tasks",
  topicId: infoTopic.id,
  subject: "info",
  grade: 5,
  order: 1,
  type: "number",
  title: "Вывод программы",
  prompt: "Какое число напечатает print(7 % 3)?",
  answer: "1",
  hint: "Найди остаток",
  solution: "После деления 7 на 3 остаётся 1.",
};
const records = [...learningContent, infoTopic, math4Topic, infoTask];

beforeEach(() => {
  freezeDate();
  localStore.remove("olympus.settings");
});
afterEach(() => vi.useRealTimers());

describe("learning context", () => {
  it("uses the linked topic's class and subject instead of old preferences", async () => {
    const { api, user } = renderApp({
      records,
      hash: `#/learn/topic/${infoTopic.id}/practice/1`,
      settings: { onboarded: true, grade: 4, subject: "math", region: "Москва" },
    });
    await heading(infoTopic.title);
    await screen.findByText(infoTask.prompt);
    expect(
      await screen.findByRole("button", { name: /5 класс · Информатика/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) => c.action === "settings" && c.payload.grade === 5 && c.payload.subject === "info",
        ),
      ).toBe(true),
    );
    expect(JSON.parse(localStorage.getItem("olympus.settings")!)).toMatchObject({
      onboarded: true,
      grade: 5,
      subject: "info",
      region: "Москва",
    });
    await user.click(screen.getByRole("button", { name: "Все темы" }));
    await heading("Учёба");
    expect(screen.getByRole("heading", { name: infoTopic.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: math4Topic.title })).toBeNull();
  });

  it("leaves the previous topic when the pupil chooses another subject", async () => {
    const { user } = renderApp({ records, hash: `#/learn/topic/${topic.id}/practice/1` });
    await heading(topic.title);
    await user.click(screen.getByRole("button", { name: /5 класс · Математика/ }));
    const dialog = await screen.findByRole("dialog", { name: "Твой класс и предмет" });
    await user.click(within(dialog).getByRole("radio", { name: "Информатика" }));
    await user.click(within(dialog).getByRole("button", { name: "Готово" }));
    await heading("Учёба");
    expect(location.hash).toBe("#/learn");
    expect(screen.getByRole("heading", { name: infoTopic.title })).toBeInTheDocument();
    expect(screen.queryByText("Сколько будет 2 + 1?")).toBeNull();
  });

  it("leaves the previous topic when the pupil chooses another class", async () => {
    const { user } = renderApp({ records, hash: `#/learn/topic/${topic.id}/practice/1` });
    await heading(topic.title);
    await user.click(screen.getByRole("button", { name: /5 класс · Математика/ }));
    const dialog = await screen.findByRole("dialog", { name: "Твой класс и предмет" });
    await user.click(within(dialog).getByRole("radio", { name: "4 класс" }));
    await user.click(within(dialog).getByRole("button", { name: "Готово" }));
    await heading("Учёба");
    expect(screen.getByRole("heading", { name: math4Topic.title })).toBeInTheDocument();
    expect(screen.queryByText("Сколько будет 2 + 1?")).toBeNull();
  });

  it("honours the first-run selection when it differs from a topic link", async () => {
    const { user } = renderApp({
      records,
      hash: `#/learn/topic/${infoTopic.id}/practice/1`,
      settings: null,
    });
    await heading("Привет! Я Олимпус");
    await user.click(screen.getByRole("radio", { name: "4 класс" }));
    await user.click(screen.getByRole("radio", { name: "Математика" }));
    await user.click(screen.getByRole("button", { name: "Начать" }));
    await heading("Учёба");
    expect(screen.getByRole("button", { name: /4 класс · Математика/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: math4Topic.title })).toBeInTheDocument();
    expect(screen.queryByText(infoTask.prompt)).toBeNull();
  });

  it("keeps the linked topic and step when the first-run selection matches", async () => {
    const { user } = renderApp({
      records,
      hash: `#/learn/topic/${infoTopic.id}/practice/1`,
      settings: null,
    });
    await heading("Привет! Я Олимпус");
    await user.click(screen.getByRole("radio", { name: "5 класс" }));
    await user.click(screen.getByRole("radio", { name: "Информатика" }));
    await user.click(screen.getByRole("button", { name: "Начать" }));
    await screen.findByText(infoTask.prompt);
    expect(location.hash).toBe(`#/learn/topic/${infoTopic.id}/practice/1`);
    expect(screen.getByRole("button", { name: /5 класс · Информатика/ })).toBeInTheDocument();
  });

  it("opens the selected subject after a normal first run", async () => {
    const { user } = renderApp({ records, settings: null });
    await heading("Привет! Я Олимпус");
    await user.click(screen.getByRole("radio", { name: "5 класс" }));
    await user.click(screen.getByRole("radio", { name: "Информатика" }));
    await user.click(screen.getByRole("button", { name: "Начать" }));
    await heading("Привет!");
    await user.click(screen.getAllByRole("button", { name: "Учёба" })[0]);
    await heading("Учёба");
    expect(screen.getByRole("button", { name: /5 класс · Информатика/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: infoTopic.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: topic.title })).toBeNull();
  });

  it("keeps the linked topic when first-run selection is skipped", async () => {
    const { user } = renderApp({
      records,
      hash: `#/learn/topic/${infoTopic.id}/practice/1`,
      settings: null,
    });
    await heading("Привет! Я Олимпус");
    await user.click(screen.getByRole("button", { name: "Пропустить" }));
    await screen.findByText(infoTask.prompt);
    expect(screen.getByRole("button", { name: /5 класс · Информатика/ })).toBeInTheDocument();
    expect(location.hash).toBe(`#/learn/topic/${infoTopic.id}/practice/1`);
  });

  it("preserves both-subject and region preferences when following a link", async () => {
    renderApp({
      records,
      hash: `#/learn/topic/${infoTopic.id}/practice/1`,
      settings: {
        onboarded: true,
        grade: 4,
        subject: "math",
        bothSubjects: true,
        region: "Москва",
      },
    });
    await screen.findByText(infoTask.prompt);
    expect(screen.getByRole("button", { name: /5 класс · Оба предмета/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("olympus.settings")!)).toMatchObject({
      onboarded: true,
      bothSubjects: true,
      region: "Москва",
      grade: 5,
      subject: "info",
    });
  });
});
