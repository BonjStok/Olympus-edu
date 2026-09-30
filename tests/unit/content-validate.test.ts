import { describe, expect, it } from "vitest";
import { regions } from "@/lib/content/regions.mjs";
import {
  CONTENT_LIMITS,
  ContentValidationError,
  findDuplicateOlympiad,
  isCalendarDate,
  isSafeUrl,
  linkedRecordIds,
  normalizeEventDate,
  normalizeTitle,
  olympiadIdentity,
  validateLinks,
  validateRecord,
} from "@/lib/content/validate.mjs";
import type { ContentRecord, Olympiad } from "@/lib/domain/types";

type Json = Record<string, unknown>;
const REGION = "Республика Алтай";

function valid(input: Json): Json {
  return validateRecord(input, { regions }) as unknown as Json;
}

function rejects(input: unknown, message: RegExp) {
  let caught: unknown;
  try {
    validateRecord(input, { regions });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContentValidationError);
  expect((caught as Error).message).toMatch(message);
  return caught as ContentValidationError;
}

const topic = (extra: Json = {}): Json => ({
  id: "math-4-01",
  kind: "topics",
  title: "Чётность",
  grade: 4,
  subject: "math",
  order: 1,
  ...extra,
});
const lesson = (extra: Json = {}): Json => ({
  id: "math-4-01-lesson-1",
  kind: "lessons",
  title: "Урок",
  topicId: "math-4-01",
  order: 1,
  blocks: [{ type: "text", value: "Текст" }],
  ...extra,
});
const task = (extra: Json = {}): Json => ({
  id: "math-4-01-task-1",
  kind: "tasks",
  title: "Задание",
  topicId: "math-4-01",
  type: "number",
  prompt: "Сколько?",
  answer: "3",
  solution: "Потому что",
  ...extra,
});
const codeTask = (extra: Json = {}): Json =>
  task({
    id: "info-4-01-task-1",
    type: "code",
    answer: undefined,
    tests: [{ input: "1\n", output: "2" }],
    ...extra,
  });
const mock = (extra: Json = {}): Json => ({
  id: "mock-4-math",
  kind: "mock-tests",
  title: "Пробник",
  grade: 4,
  subject: "math",
  olympiad: "Учебный тур",
  minutes: 40,
  taskIds: ["t1", "t2", "t3"],
  ...extra,
});
const olympiad = (extra: Json = {}): Json => ({
  id: "olymp-1",
  kind: "olympiads",
  title: "Математический старт",
  subject: "math",
  grades: [4, 5],
  format: "online",
  region: "",
  deadline: "2026-10-01",
  date: "2026-10-10",
  url: "https://example.ru/olymp",
  ...extra,
});

describe("isCalendarDate", () => {
  it.each([
    ["2026-10-10", true],
    ["2024-02-29", true],
    ["2026-02-30", false],
    ["2025-02-29", false],
    ["2026-13-01", false],
    ["2026-1-01", false],
    ["expected", false],
    [20261010, false],
    [null, false],
  ])("%s → %s", (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected);
  });
});

describe("normalizeEventDate", () => {
  it.each([
    ["ожидается", "expected"],
    [" Ожидается ", "expected"],
    ["pending", "expected"],
    ["EXPECTED", "expected"],
    [" 2026-10-10 ", "2026-10-10"],
    [42, 42],
    [undefined, undefined],
  ])("%s → %s", (value, expected) => {
    expect(normalizeEventDate(value)).toBe(expected);
  });
});

describe("isSafeUrl", () => {
  it.each([
    ["", true],
    [undefined, true],
    [null, true],
    ["https://example.ru/page?x=1", true],
    ["http://example.ru", false],
    ["javascript:alert(1)", false],
    ["https://user:pass@example.ru", false],
    ["//example.ru", false],
    ["not a url", false],
    ["/api/media/0b3c5d0e-1111-2222-3333-444455556666", true],
    ["/olympiad-default.png", true],
    ["/olympiad-default.webp", true],
    ["/api/media/../secret", false],
    ["/api/media//evil.example", false],
    ["/etc/passwd", false],
    [123, false],
    ["https://example.ru/" + "a".repeat(CONTENT_LIMITS.url), false],
  ])("%s → %s", (value, expected) => {
    expect(isSafeUrl(value)).toBe(expected);
  });

  it("rejects local paths when they are not allowed", () => {
    expect(isSafeUrl("/api/media/abc", { allowLocal: false })).toBe(false);
  });
});

describe("validateRecord – common rules", () => {
  it("returns a normalised copy and leaves the input untouched", () => {
    const input = topic({ grade: "5", order: "2" });
    const result = valid(input);
    expect(result).toMatchObject({ grade: 5, order: 2 });
    expect(input.grade).toBe("5");
  });

  it("uses the kind from options (content folders)", () => {
    const { kind: _kind, ...rest } = topic();
    expect(validateRecord(rest, { regions, kind: "topics" }).kind).toBe("topics");
  });

  it.each([
    [null, /JSON-объектом/],
    [[], /JSON-объектом/],
    ["topic", /JSON-объектом/],
  ])("rejects a non-object %j", (input, message) => {
    rejects(input, message);
  });

  it.each([
    [{ kind: "users" }, /Неизвестный тип материала/],
    [{ id: "bad id" }, /ID: латинские буквы/],
    [{ id: "a".repeat(101) }, /ID: латинские буквы/],
    [{ title: "   " }, /Укажите название/],
    [{ title: undefined }, /Укажите название/],
    [{ title: 42 }, /должно быть строкой/],
    [{ title: "x".repeat(CONTENT_LIMITS.title + 1) }, /длиннее/],
    [{ demo: "yes" }, /true или false/],
    [{ unpublished: 1 }, /true или false/],
    [{ grade: 7 }, /класс от 4 до 6/],
    [{ grade: true }, /класс от 4 до 6/],
    [{ subject: "physics" }, /math или info/],
    [{ order: -1 }, /order/],
    [{ order: 1.5 }, /order/],
    [{ order: true }, /order/],
  ])("rejects %j", (patch, message) => {
    rejects(topic(patch), message);
  });

  it("prefixes messages with a valid record id and exposes it", () => {
    const error = rejects(topic({ grade: 9 }), /^math-4-01: /);
    expect(error.recordId).toBe("math-4-01");
    expect(error.code).toBe("VALIDATION_ERROR");
  });
});

describe("validateRecord – topics", () => {
  it("accepts a topic and drops a null description", () => {
    const result = valid(topic({ description: null }));
    expect(result).not.toHaveProperty("description");
  });

  it.each([
    [{ grade: undefined }, /класс темы/],
    [{ subject: undefined }, /предмет темы/],
    [{ description: "x".repeat(CONTENT_LIMITS.description + 1) }, /длиннее/],
  ])("rejects %j", (patch, message) => {
    rejects(topic(patch), message);
  });
});

describe("validateRecord – lessons", () => {
  it("accepts every block type with safe links", () => {
    const blocks = [
      { type: "text", value: "a" },
      { type: "example", value: "b" },
      { type: "formula", value: "a^2" },
      { type: "list", value: "1\n2" },
      { type: "table", value: "|a|" },
      { type: "code", value: "print(1)", caption: "Python" },
      { type: "image", value: "/api/media/0b3c5d0e-1111-2222-3333-444455556666" },
      { type: "video", value: "https://video.example/1.mp4" },
      { type: "link", value: "" },
    ];
    expect(valid(lesson({ blocks })).blocks).toEqual(blocks);
  });

  it.each([
    [{ topicId: undefined }, /тему урока/],
    [{ topicId: "bad id" }, /тему урока/],
    [{ blocks: [] }, /хотя бы один блок/],
    [{ blocks: "text" }, /хотя бы один блок/],
    [
      {
        blocks: Array.from({ length: CONTENT_LIMITS.blocks + 1 }, () => ({
          type: "text",
          value: "",
        })),
      },
      /не больше/,
    ],
    [{ blocks: ["text"] }, /должен быть объектом/],
    [{ blocks: [{ type: "html", value: "<b>" }] }, /Неизвестный тип блока/],
    [{ blocks: [{ type: "text", value: 1 }] }, /должно быть строкой/],
    [
      { blocks: [{ type: "text", value: "x".repeat(CONTENT_LIMITS.richText + 1) }] },
      /слишком длинный/,
    ],
    [{ blocks: [{ type: "text", value: "a", caption: 5 }] }, /Подпись/],
    [{ blocks: [{ type: "image", value: "http://example.ru/a.png" }] }, /https/],
    [{ blocks: [{ type: "link", value: "javascript:alert(1)" }] }, /https/],
  ])("rejects %j", (patch, message) => {
    rejects(lesson(patch), message);
  });
});

describe("validateRecord – tasks", () => {
  it("accepts a number task and normalises points and numeric answers", () => {
    expect(valid(task({ points: "2", answer: 12 }))).toMatchObject({ points: 2, answer: "12" });
    expect(valid(task({ answer: " -1,5 " }))).toMatchObject({ answer: " -1,5 " });
  });

  it("accepts proof tasks without an answer and code tasks with tests and an example", () => {
    expect(valid(task({ type: "proof", answer: undefined })).type).toBe("proof");
    const code = valid(codeTask({ example: { input: "1\n", output: "2" } }));
    expect(code.tests).toHaveLength(1);
  });

  it("accepts a prompt with a fenced program (informatics number tasks)", () => {
    const prompt = "Что выведет программа?\n```python\nprint(2 + 3)\n```";
    expect(valid(task({ prompt, answer: "5" })).prompt).toBe(prompt);
  });

  it.each([
    [{ topicId: undefined }, /тему задания/],
    [{ type: "essay" }, /тип задания/],
    [{ prompt: "" }, /условие/],
    [{ solution: undefined }, /разбор/],
    [{ hint: "x".repeat(CONTENT_LIMITS.description + 1) }, /длиннее/],
    [{ points: -1 }, /отрицательными/],
    [{ points: "abc" }, /отрицательными/],
    [{ points: true }, /отрицательными/],
    [{ points: CONTENT_LIMITS.points + 1 }, /не больше/],
    [{ answer: { value: 3 } }, /строкой/],
    [{ answer: Number.NaN }, /строкой/],
    [{ answer: "три" }, /числовой/],
    [{ answer: undefined }, /числовой/],
    [{ type: "proof", answer: "x".repeat(CONTENT_LIMITS.shortText + 1) }, /слишком длинный/],
    [{ tests: [{ input: 1, output: "1" }] }, /input и output/],
    [{ tests: "none" }, /input и output/],
    [{ example: { input: "1" } }, /Пример/],
  ])("rejects number/proof task with %j", (patch, message) => {
    rejects(task(patch), message);
  });

  it.each([
    [{ tests: [] }, /Добавьте вход/],
    [{ tests: undefined }, /Добавьте вход/],
    [
      {
        tests: Array.from({ length: CONTENT_LIMITS.tests + 1 }, () => ({ input: "", output: "" })),
      },
      /Не больше/,
    ],
    [{ tests: [{ input: "1", output: null }] }, /input и output/],
    [{ tests: [{ input: "x".repeat(CONTENT_LIMITS.testText + 1), output: "" }] }, /input и output/],
  ])("rejects code task with %j", (patch, message) => {
    rejects(codeTask(patch), message);
  });
});

describe("validateRecord – mock tests", () => {
  it("accepts fixed and randomised mocks and normalises numbers", () => {
    expect(valid(mock({ minutes: "45" })).minutes).toBe(45);
    expect(valid(mock({ randomize: true, taskCount: "2" }))).toMatchObject({ taskCount: 2 });
  });

  it.each([
    [{ grade: undefined }, /класс пробника/],
    [{ subject: undefined }, /предмет пробника/],
    [{ olympiad: 5 }, /строкой/],
    [{ minutes: 0 }, /Время пробника/],
    [{ minutes: CONTENT_LIMITS.minutes + 1 }, /Время пробника/],
    [{ minutes: true }, /Время пробника/],
    [{ taskIds: [] }, /хотя бы одно задание/],
    [
      { taskIds: Array.from({ length: CONTENT_LIMITS.taskIds + 1 }, (_, i) => `t${i}`) },
      /не больше/,
    ],
    [{ taskIds: ["ok", "bad id"] }, /ID заданий/],
    [{ taskIds: ["t1", "t1"] }, /повторяющихся/],
    [{ randomize: "yes" }, /true или false/],
    [{ taskCount: 1.5 }, /количество/],
    [{ taskCount: false }, /количество/],
    [{ randomize: true }, /количество/],
    [{ randomize: true, taskCount: 0 }, /количество/],
    [{ randomize: true, taskCount: 4 }, /количество/],
  ])("rejects %j", (patch, message) => {
    rejects(mock(patch), message);
  });
});

describe("validateRecord – olympiads (schema v2)", () => {
  it("accepts a full v2 record", () => {
    const result = valid(
      olympiad({
        subjects: ["math", "info"],
        region: REGION,
        series: "vsosh-school-2026-math",
        stage: "Школьный этап",
        registrationType: "link",
        registrationStart: "2026-09-01",
        dateEnd: "2026-10-12",
        source: "https://olimpiada.ru/activity/1",
        verifiedAt: "2026-09-20",
        price: "0",
        image: "/olympiad-default.webp",
        featured: true,
        grades: ["4", 6],
      }),
    );
    expect(result).toMatchObject({ price: 0, grades: [4, 6], region: REGION });
  });

  it("fills an empty region and url and drops empty optional dates", () => {
    const result = valid(
      olympiad({
        region: undefined,
        url: null,
        registrationStart: "",
        dateEnd: "",
        registrationType: null,
      }),
    );
    expect(result.region).toBe("");
    expect(result.url).toBe("");
    expect(result).not.toHaveProperty("registrationStart");
    expect(result).not.toHaveProperty("dateEnd");
    expect(result).not.toHaveProperty("registrationType");
  });

  it("accepts an offline olympiad for the whole country (region «»)", () => {
    expect(valid(olympiad({ format: "offline", region: "" })).format).toBe("offline");
  });

  it("normalises «ожидается» and «pending» dates", () => {
    const result = valid(olympiad({ date: "ожидается", deadline: "pending" }));
    expect(result).toMatchObject({ date: "expected", deadline: "expected" });
  });

  it("requires a deadline for link registration only", () => {
    rejects(olympiad({ deadline: undefined }), /дедлайн/);
    rejects(olympiad({ deadline: "" }), /дедлайн/);
    const school = valid(olympiad({ registrationType: "school", deadline: "" }));
    expect(school).not.toHaveProperty("deadline");
    expect(valid(olympiad({ registrationType: "school", deadline: "2026-09-30" })).deadline).toBe(
      "2026-09-30",
    );
  });

  it.each([
    [{ subject: undefined }, /предмет олимпиады/],
    [{ subjects: [] }, /subjects/],
    [{ subjects: ["math", "art"] }, /subjects/],
    [{ subjects: ["math", "math"] }, /subjects/],
    [{ subjects: ["info"] }, /основной предмет/],
    [{ grades: [] }, /классы олимпиады/],
    [{ grades: [3] }, /класс от 4 до 6/],
    [{ grades: [4, "4"] }, /не должны повторяться/],
    [{ format: "hybrid" }, /online или offline/],
    [{ region: "Атлантида" }, /не найден в справочнике/],
    [{ region: "none" }, /не найден в справочнике/],
    [{ region: 77 }, /строкой/],
    [{ series: "VSOSH_2026" }, /series/],
    [{ series: "a-" }, /series/],
    [{ series: 5 }, /series/],
    [{ stage: "x".repeat(CONTENT_LIMITS.shortText + 1) }, /длиннее/],
    [{ featured: "yes" }, /true или false/],
    [{ registrationType: "email" }, /link или school/],
    [{ url: "http://example.ru" }, /https/],
    [{ url: 5 }, /https/],
    [{ image: "http://example.ru/a.png" }, /Изображение/],
    [{ source: "http://olimpiada.ru" }, /source/],
    [{ source: "" }, /source/],
    [{ source: "/api/media/0b3c5d0e-1111-2222-3333-444455556666" }, /source/],
    [{ verifiedAt: "2026-02-30" }, /verifiedAt/],
    [{ verifiedAt: "вчера" }, /verifiedAt/],
    [{ price: -100 }, /отрицательной/],
    [{ price: true }, /отрицательной/],
    [{ price: CONTENT_LIMITS.price + 1 }, /слишком большая/],
    [{ date: "2026-10-32" }, /Дата проведения/],
    [{ date: undefined }, /Дата проведения/],
    [{ deadline: "скоро" }, /Дедлайн регистрации/],
    [{ registrationStart: "01.09.2026" }, /Начало регистрации/],
    [{ dateEnd: "2026/10/12" }, /Дата окончания/],
    [{ dateEnd: "2026-10-09" }, /раньше даты проведения/],
    [{ date: "expected", dateEnd: "2026-10-12" }, /точной датой начала/],
    [{ deadline: "2026-10-11" }, /позже окончания олимпиады/],
    [{ deadline: "2026-10-13", dateEnd: "2026-10-12" }, /позже окончания олимпиады/],
    [{ registrationStart: "2026-10-02" }, /позже дедлайна/],
    [{ deadline: "expected", registrationStart: "2026-10-11" }, /позже окончания олимпиады/],
  ])("rejects %j", (patch, message) => {
    rejects(olympiad(patch), message);
  });

  it("lets registration stay open until the last day of a multi-day event", () => {
    const record = valid(olympiad({ deadline: "2026-10-12", dateEnd: "2026-10-14" }));
    expect(record.deadline).toBe("2026-10-12");
  });

  it("accepts offline all-Russia events and punycode links", () => {
    const record = valid(
      olympiad({
        format: "offline",
        region: "",
        url: "https://xn--80aaaa1bhnclcci1cl5c4ep.xn--p1ai/",
      }),
    );
    expect(record.region).toBe("");
  });

  it("allows equal dates at the boundaries", () => {
    expect(
      valid(
        olympiad({
          registrationStart: "2026-10-10",
          deadline: "2026-10-10",
          dateEnd: "2026-10-10",
        }),
      ).date,
    ).toBe("2026-10-10");
  });
});

describe("olympiad duplicates", () => {
  const base = olympiad() as unknown as Olympiad;

  it.each([
    ["Математический старт", "«Математический  СТАРТ»"],
    ["Олимпиада – школьный этап", "олимпиада - школьный этап"],
    // Em dash from Word or old calendar data counts as the same title.
    ["Олимпиада \u2014 школьный этап", "Олимпиада – школьный этап"],
    ["Ёлка: финал", "елка финал"],
  ])("normalises «%s» and «%s» to the same title", (a, b) => {
    expect(normalizeTitle(a)).toBe(normalizeTitle(b));
  });

  it("builds the identity from title, region and date", () => {
    expect(olympiadIdentity({ title: "Старт!", region: REGION, date: "expected" })).toBe(
      `старт|${REGION}|expected`,
    );
    expect(olympiadIdentity({ title: "Старт", region: "", date: "" })).toBe("старт||");
  });

  it("finds a duplicate inside the batch", () => {
    const copy = { ...base, id: "olymp-2", title: "МАТЕМАТИЧЕСКИЙ СТАРТ" };
    expect(findDuplicateOlympiad([base, copy])).toEqual({ record: copy, duplicateOf: base });
  });

  it("finds a duplicate against existing records with another id", () => {
    const incoming = { ...base, id: "olymp-new" };
    expect(findDuplicateOlympiad([incoming], [base])?.duplicateOf.id).toBe("olymp-1");
  });

  it("does not treat an update of the same record as a duplicate", () => {
    expect(findDuplicateOlympiad([{ ...base, url: "https://new.example" }], [base])).toBeNull();
  });

  it("compares a replaced record in its new form", () => {
    const other = { ...base, id: "olymp-2", date: "2026-11-01" };
    // olymp-2 moves to the date of olymp-1 while olymp-1 moves away: no conflict.
    const moved = [
      { ...base, date: "2026-12-01" },
      { ...other, date: "2026-10-10" },
    ];
    expect(findDuplicateOlympiad(moved, [base, other])).toBeNull();
  });

  it("different region or date is not a duplicate; other kinds are ignored", () => {
    const regional = { ...base, id: "olymp-2", region: REGION };
    const later = { ...base, id: "olymp-3", date: "2026-11-01" };
    const notOlympiad = { ...base, id: "t", kind: "topics" } as unknown as Olympiad;
    expect(findDuplicateOlympiad([base, regional, later, notOlympiad], [notOlympiad])).toBeNull();
  });
});

describe("validateLinks and linkedRecordIds", () => {
  const topicRecord = topic() as unknown as ContentRecord;

  it("lists the topics and tasks records point to", () => {
    const records = [lesson(), task(), mock({ taskIds: ["a", "b"] })] as unknown as ContentRecord[];
    expect(linkedRecordIds(records).sort()).toEqual(["a", "b", "math-4-01"]);
  });

  it("fills grade and subject of lessons and tasks from the topic", () => {
    const records = [lesson(), task()] as unknown as ContentRecord[];
    validateLinks(records, new Map([["math-4-01", topicRecord]]));
    expect(records[0]).toMatchObject({ grade: 4, subject: "math" });
    expect(records[1]).toMatchObject({ grade: 4, subject: "math" });
  });

  it("checks mock tasks against their inherited grade and subject in the same batch", () => {
    const records = [
      topicRecord,
      task({ id: "t1" }),
      task({ id: "t2" }),
      mock({ taskIds: ["t1", "t2"] }),
    ] as unknown as ContentRecord[];
    expect(() => validateLinks(records, new Map())).not.toThrow();
  });

  it.each([
    ["missing topic", [lesson({ topicId: "nope" })], /тема nope не найдена/],
    ["topic id pointing to a task", [task({ topicId: "t9" }), task({ id: "t9" })], /не найдена/],
    ["another grade", [topicRecord, task({ grade: 5 })], /другому классу/],
    ["another subject", [topicRecord, lesson({ subject: "info" })], /другому классу/],
    ["unknown mock task", [mock({ taskIds: ["ghost"] })], /задание ghost не найдено/],
    [
      "mock task of another grade",
      [topicRecord, task({ id: "t1" }), mock({ taskIds: ["t1"], grade: 6 })],
      /t1 относится к другому классу/,
    ],
  ])("rejects %s", (_name, records, message) => {
    let caught: unknown;
    try {
      validateLinks(records as unknown as ContentRecord[], new Map());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContentValidationError);
    expect((caught as Error).message).toMatch(message);
    expect((caught as ContentValidationError).recordId).toBeTruthy();
  });
});
