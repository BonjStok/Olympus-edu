/** JSON import examples shown to teachers (same shape the server stores). */
import type { RecordKind } from "@/lib/domain/types";

export const JSON_EXAMPLES: Record<RecordKind, unknown[]> = {
  olympiads: [
    {
      id: "olimpiada-primer-2026",
      title: "Олимпиада «Пример» – математика",
      subject: "math",
      grades: [4, 5, 6],
      format: "online",
      region: "",
      registrationType: "link",
      url: "https://example.ru",
      registrationStart: "2026-10-01",
      deadline: "2026-10-10",
      date: "2026-10-15",
      price: 0,
      description: "Короткое описание для детей",
      source: "https://example.ru",
    },
    {
      id: "olimpiada-daty-ozhidayutsya",
      title: "Олимпиада – даты ожидаются",
      subject: "info",
      grades: [5, 6],
      format: "online",
      region: "",
      url: "https://example.ru",
      deadline: "expected",
      date: "expected",
      price: 0,
    },
  ],
  topics: [
    {
      id: "math-4-primer",
      title: "Название темы",
      grade: 4,
      subject: "math",
      order: 1,
      description: "Краткое описание темы",
    },
  ],
  lessons: [
    {
      id: "lesson-primer-1",
      title: "Название урока",
      grade: 4,
      subject: "math",
      topicId: "math-4-primer",
      order: 1,
      blocks: [
        { type: "text", value: "Текст урока" },
        { type: "example", value: "Разбор примера" },
      ],
    },
  ],
  tasks: [
    {
      id: "task-primer-1",
      title: "Чётные числа до 6",
      grade: 4,
      subject: "math",
      topicId: "math-4-primer",
      order: 1,
      type: "number",
      prompt: "Сколько чётных чисел от 1 до 6?",
      answer: "3",
      solution: "Чётные числа: 2, 4, 6 – их три.",
      hint: "Выпиши числа от 1 до 6 и обведи те, что делятся на 2",
      points: 1,
    },
  ],
  "mock-tests": [
    {
      id: "mock-primer",
      title: "Пробный тур · 4 класс",
      grade: 4,
      subject: "math",
      olympiad: "Название олимпиады",
      minutes: 40,
      taskIds: ["task-primer-1"],
      randomize: false,
      taskCount: 1,
    },
  ],
};
