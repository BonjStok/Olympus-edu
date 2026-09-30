// A small synthetic course for the integration tests. Grading, stars, mocks, drafts and the code
// runner are tested against these records instead of the real content (content/ is rewritten from
// time to time: new answers, new task types, new mocks). The records go through the same
// validation and publish path as an admin import (lib/services/admin.ts), so they are always valid
// content. Ids start with `fx-` and never clash with the bundle.
//
// Tests read answers, points, minutes and task lists from these records instead of repeating the
// numbers, so the fixtures can change without touching every assertion.
import type { ContentRecord, Lesson, MockTest, Olympiad, Task, Topic } from "@/lib/domain/types";

const topic = (id: string, grade: 4 | 5, subject: "math" | "info", title: string): Topic => ({
  kind: "topics",
  id,
  title,
  grade,
  subject,
  order: 90,
  description: `Тестовая тема «${title}» для интеграционных тестов`,
});

const lesson = (topicId: string, order: number): Lesson =>
  ({
    kind: "lessons",
    id: `${topicId}-lesson-${order}`,
    title: `Урок ${order}`,
    topicId,
    order,
    blocks: [{ type: "text", value: `Текст урока ${order}` }],
  }) as Lesson;

const numberTask = (
  topicId: string,
  order: number,
  answer: string,
  points: number,
  extra: Partial<Task> = {},
): Task =>
  ({
    kind: "tasks",
    id: `${topicId}-n${order}`,
    title: `Задача ${order}`,
    topicId,
    order,
    type: "number",
    prompt: `Условие задачи ${order}`,
    answer,
    solution: `Разбор задачи ${order}: ответ ${answer}`,
    hint: `Подсказка к задаче ${order}: считай по шагам`,
    points,
    ...extra,
  }) as Task;

/** Tests of `print(int(input()) + 1)`: the fake runners accept exactly this program. */
const plusOneTests = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    input: `${index + 1}\n`,
    output: `${index + 2}\n`,
  }));

/** Programming task without a reference answer (as in the real content). */
const codeTask = (id: string, order: number, testCount: number, points: number): Task => {
  const tests = plusOneTests(testCount);
  return {
    kind: "tasks",
    id,
    title: `Программа ${order}`,
    topicId: "fx-info",
    order,
    type: "code",
    prompt: "Прочитай число и выведи следующее",
    solution: "print(int(input()) + 1)",
    hint: "Преобразуй строку в число",
    tests,
    example: tests[0],
    points,
  } as Task;
};

const mock = (
  id: string,
  subject: "math" | "info",
  minutes: number,
  taskIds: string[],
  extra: Partial<MockTest> = {},
): MockTest => ({
  kind: "mock-tests",
  id,
  title: `Тестовый пробник ${id}`,
  olympiad: "Тестовая олимпиада",
  grade: 4,
  subject,
  minutes,
  taskIds,
  ...extra,
});

const MATH_NUMBERS = [
  numberTask("fx-math", 1, "3", 1),
  numberTask("fx-math", 2, "12", 1),
  numberTask("fx-math", 3, "7", 2),
  numberTask("fx-math", 4, "9", 2),
  numberTask("fx-math", 5, "1.5", 3),
];

const PROOF: Task = {
  kind: "tasks",
  id: "fx-math-proof",
  title: "Докажи",
  topicId: "fx-math",
  order: 6,
  type: "proof",
  prompt: "Докажи, что сумма двух чётных чисел чётна",
  solution: "2a + 2b = 2(a + b)",
  points: 2,
} as Task;

/** «Что выведет программа?»: a number task in an informatics topic. */
const TRACE = numberTask("fx-info", 1, "13", 1, {
  title: "Что выведет программа?",
  prompt: "x = 6\nprint(x * 2 + 1)",
});

const CODE = [
  codeTask("fx-info-code-1", 2, 5, 2),
  codeTask("fx-info-code-2", 3, 3, 3),
  codeTask("fx-info-code-3", 4, 3, 3),
];

const GRADE5_TOPIC = topic("fx-math-5", 5, "math", "Тема пятого класса");
const GRADE5_TASK = numberTask("fx-math-5", 1, "5", 1);

const OLYMPIAD: Olympiad = {
  kind: "olympiads",
  id: "fx-olympiad",
  title: "Тестовая олимпиада для интеграционных тестов",
  subject: "math",
  grades: [4, 5, 6],
  format: "online",
  region: "",
  url: "https://example.org/register",
  deadline: "expected",
  date: "expected",
};

const MOCKS = {
  /** Number tasks with different points; `FX.outsideMathMock` is not part of it. */
  math: mock(
    "fx-mock-math",
    "math",
    40,
    MATH_NUMBERS.slice(0, 4).map((task) => task.id),
  ),
  /** Mixed like the real informatics mocks: a tracing (number) task and programs. */
  info: mock("fx-mock-info", "info", 75, [TRACE.id, ...CODE.map((task) => task.id)]),
  /** «Большой тур»-style: a random sample of `taskCount` tasks. */
  random: mock(
    "fx-mock-random",
    "math",
    60,
    MATH_NUMBERS.map((task) => task.id),
    { randomize: true, taskCount: 3 },
  ),
  proof: mock("fx-mock-proof", "math", 5, [PROOF.id, MATH_NUMBERS[0].id]),
};

export const FIXTURE_RECORDS: readonly ContentRecord[] = [
  topic("fx-math", 4, "math", "Тестовая математика"),
  topic("fx-info", 4, "info", "Тестовая информатика"),
  GRADE5_TOPIC,
  lesson("fx-math", 1),
  lesson("fx-math", 2),
  lesson("fx-math", 3),
  lesson("fx-info", 1),
  ...MATH_NUMBERS,
  PROOF,
  TRACE,
  ...CODE,
  GRADE5_TASK,
  OLYMPIAD,
  ...Object.values(MOCKS),
];

/** Named handles to the fixture records. */
export const FX = {
  mathTopic: "fx-math",
  infoTopic: "fx-info",
  /** Published lessons of `mathTopic`, in order. */
  mathLessons: ["fx-math-lesson-1", "fx-math-lesson-2", "fx-math-lesson-3"],
  /** Number tasks of `mathTopic` in order: answers and points differ on purpose. */
  numbers: MATH_NUMBERS,
  /** Number task of `mathTopic` that is not part of `mocks.math`. */
  outsideMathMock: MATH_NUMBERS[4],
  proof: PROOF,
  trace: TRACE,
  code: CODE,
  /** The program every fake runner treats as correct. */
  goodProgram: "print(int(input()) + 1)",
  grade5Topic: GRADE5_TOPIC,
  grade5Task: GRADE5_TASK,
  olympiad: OLYMPIAD,
  mocks: MOCKS,
} as const;

/** Fixture task by id (throws on a typo instead of returning undefined). */
export function fixtureTask(id: string): Task {
  const task = FIXTURE_RECORDS.find((record) => record.id === id);
  if (task?.kind !== "tasks") throw new Error(`no fixture task ${id}`);
  return task;
}

/** Sum of points of the given fixture tasks (points default to 1, as on the server). */
export function pointsOf(ids: readonly string[]): number {
  return ids.reduce((sum, id) => sum + (fixtureTask(id).points ?? 1), 0);
}

/** Correct answers of the number tasks among `ids`, keyed by task id. */
export function correctAnswers(ids: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    ids.flatMap((id) => {
      const task = fixtureTask(id);
      return task.type === "number" ? [[id, task.answer as string]] : [];
    }),
  );
}
