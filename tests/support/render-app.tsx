import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { ContentRecord, Lesson, MockTest, Olympiad, Task, Topic } from "@/lib/domain/types";
import { App } from "@/components/olympus/App";
import type { LocalSettings } from "@/components/olympus/state/data";
import { createFakeApi, type FakeServerOptions } from "./fake-api";

/** Fixed «today» for tests: fixtures use the 2026/27 school year. */
export const NOW = new Date("2026-09-29T09:00:00+03:00");

export function freezeDate() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

export const topic: Topic = {
  id: "math-5-01",
  kind: "topics",
  title: "Делимость чисел",
  grade: 5,
  subject: "math",
  order: 1,
};

export const nextTopic: Topic = {
  id: "math-5-02",
  kind: "topics",
  title: "Остатки",
  grade: 5,
  subject: "math",
  order: 2,
};

export const lessons: Lesson[] = [1, 2].map((n) => ({
  id: `math-5-01-l${n}`,
  kind: "lessons",
  title: n === 1 ? "Главная идея" : "Признаки делимости",
  grade: 5,
  subject: "math",
  topicId: topic.id,
  order: n,
  blocks: [{ type: "text", value: `Текст урока ${n}` }],
}));

export const tasks: Task[] = [3, 4, 5, 6].map((answer, i) => ({
  id: `math-5-01-t${i + 1}`,
  kind: "tasks",
  title: `Задание ${i + 1}`,
  grade: 5,
  subject: "math",
  topicId: topic.id,
  order: i + 1,
  type: "number",
  prompt: `Сколько будет ${answer - 1} + 1?`,
  answer: String(answer),
  solution: `Ответ ${answer}`,
  hint: "Прибавь единицу",
  points: 1,
}));

export const mock: MockTest = {
  id: "mock-5-math",
  kind: "mock-tests",
  title: "Пробный тур • 5 класс",
  grade: 5,
  subject: "math",
  olympiad: "Учебный тур Олимпуса",
  minutes: 40,
  taskIds: [tasks[0].id, tasks[1].id],
};

export function olympiad(patch: Partial<Olympiad>): Olympiad {
  return {
    id: "olymp",
    kind: "olympiads",
    title: "Олимпиада «Бельчонок» – математика",
    subject: "math",
    grades: [4, 5, 6],
    format: "online",
    region: "",
    registrationType: "link",
    url: "https://example.ru/reg",
    date: "2026-10-20",
    deadline: "2026-10-12",
    price: 0,
    ...patch,
  };
}

export const learningContent: ContentRecord[] = [topic, nextTopic, ...lessons, ...tasks, mock];

export function renderApp(
  options: Partial<FakeServerOptions> & {
    settings?: LocalSettings | null;
    hash?: string;
  } = {},
) {
  const {
    settings = { onboarded: true, grade: 5, subject: "math" },
    hash = "#/home",
    ...server
  } = options;
  if (settings) localStorage.setItem("olympus.settings", JSON.stringify(settings));
  history.replaceState(null, "", "/" + hash);
  const api = createFakeApi({ records: learningContent, ...server });
  const user = userEvent.setup();
  const utils = render(<App api={api} />);
  return { api, user, ...utils };
}

/** The screen heading once the app has loaded. */
export async function heading(name: string | RegExp) {
  return screen.findByRole("heading", { level: 1, name }, { timeout: 5000 });
}
