import { describe, expect, it } from "vitest";
import type { Lesson, MockTest, Olympiad, Task, Topic } from "@/lib/domain/types";
import {
  errorsFromServerMessage,
  firstErrorField,
  newRecord,
  prepareRecord,
  uniqueId,
  validateRecord,
  type EditorContext,
} from "@/lib/ui/admin-records";
import { detectDelimiter, parseCsv, toCsv } from "@/lib/ui/csv";
import { formatCsvError, olympiadCsvTemplate, olympiadsFromCsv } from "@/lib/ui/olympiad-csv";

const topics = [
  { id: "math-4-01", grade: 4, subject: "math", title: "Чётность" },
  { id: "math-5-01", grade: 5, subject: "math", title: "Делимость" },
] as Topic[];
const tasks = [{ id: "t1", grade: 4, subject: "math" }] as Task[];
const ctx: EditorContext = { topics, tasks, existingIds: new Set(["taken"]) };

describe("new records and ids", () => {
  it("creates sensible defaults", () => {
    const o = newRecord("olympiads", ctx) as Olympiad;
    expect(o).toMatchObject({
      kind: "olympiads",
      format: "online",
      region: "",
      registrationType: "link",
      date: "expected",
    });
    const t = newRecord("tasks", ctx, { grade: 5, subject: "math" }) as Task;
    expect(t.topicId).toBe("math-5-01");
    expect(t.type).toBe("number");
  });

  it("generates unique latin ids", () => {
    expect(uniqueId("Чётность и нечётность", new Set())).toBe("chetnost-i-nechetnost");
    expect(uniqueId("Taken", ctx.existingIds)).toBe("taken-2");
    expect(uniqueId("", new Set())).toBe("material");
  });
});

describe("validation with teacher-friendly messages", () => {
  it("requires a title; an offline olympiad may be all-Russia and the link may come later", () => {
    const o: Olympiad = {
      ...(newRecord("olympiads", ctx) as Olympiad),
      id: "x",
      format: "offline",
      url: "",
    };
    const e = validateRecord(o, ctx);
    expect(e).toEqual({ title: "Впишите название" });
    expect(firstErrorField(e)).toBe("title");
    // «Кенгуру»: held offline in many cities, open to the whole country.
    expect(validateRecord(prepareRecord({ ...o, title: "Кенгуру" }), ctx)).toEqual({});
  });

  it("lets registration stay open until the last day of a multi-day olympiad", () => {
    const o: Olympiad = {
      ...(newRecord("olympiads", ctx) as Olympiad),
      id: "window",
      title: "Интернет-олимпиада",
      url: "https://olympiads.ru",
      date: "2026-10-20",
      dateEnd: "2026-11-10",
      deadline: "2026-11-01",
    };
    expect(validateRecord(prepareRecord(o), ctx)).toEqual({});
    const late = validateRecord(prepareRecord({ ...o, deadline: "2026-11-11" }), ctx);
    expect(late.deadline).toMatch(/позже последнего дня олимпиады/);
  });

  it("places the server's own rules at their fields", () => {
    const m: MockTest = {
      ...(newRecord("mock-tests", ctx) as MockTest),
      id: "long",
      title: "Тур",
      grade: 4,
      minutes: 601,
      taskIds: ["t1"],
    };
    // The editor has no rule for the upper limit: the shared validator of the server does.
    expect(validateRecord(m, ctx)).toEqual({ minutes: "Время пробника: от 1 до 600 минут" });
    expect(errorsFromServerMessage("long: задание t9 не найдено", "long")).toEqual({
      taskIds: "Задание «t9» удалено – уберите его из пробника или восстановите в «Удалённых»",
    });
    expect(
      errorsFromServerMessage(
        "x: Дедлайн регистрации не может быть позже окончания олимпиады",
        "x",
      ),
    ).toEqual({ deadline: "Дедлайн регистрации не может быть позже окончания олимпиады" });
  });

  it("names a deleted task of a mock and how to fix it", () => {
    const m: MockTest = {
      ...(newRecord("mock-tests", ctx) as MockTest),
      id: "m2",
      title: "Тур",
      grade: 4,
      taskIds: ["t1", "gone"],
    };
    expect(validateRecord(m, ctx).taskIds).toBe(
      "Задание «gone» удалено – уберите его из пробника или восстановите в «Удалённых»",
    );
  });

  it("drops empty lesson blocks and empty test rows before saving", () => {
    const lesson = prepareRecord({
      ...(newRecord("lessons", ctx) as Lesson),
      blocks: [
        { type: "text", value: "Текст" },
        { type: "text", value: "  " },
      ],
    }) as Lesson;
    expect(lesson.blocks).toHaveLength(1);
    const task = prepareRecord({
      ...(newRecord("tasks", ctx) as Task),
      type: "code",
      tests: [
        { input: "1", output: "2" },
        { input: "", output: "" },
      ],
    }) as Task;
    expect(task.tests).toHaveLength(1);
  });

  it("checks dates and links", () => {
    const o: Olympiad = {
      ...(newRecord("olympiads", ctx) as Olympiad),
      id: "x",
      title: "Турнир",
      url: "http://insecure.ru",
      date: "2026-10-10",
      deadline: "2026-10-20",
      dateEnd: "2026-10-01",
      region: "Нарния",
    };
    const e = validateRecord(o, ctx);
    expect(e.url).toBe("Ссылка должна начинаться с https://");
    expect(e.deadline).toMatch(/позже последнего дня олимпиады/);
    expect(e.dateEnd).toMatch(/раньше даты начала/);
    expect(e.region).toBe("Выберите регион из списка");
  });

  it("accepts a complete olympiad; school registration may have no deadline", () => {
    const o: Olympiad = {
      ...(newRecord("olympiads", ctx) as Olympiad),
      id: "ok",
      title: "ВсОШ",
      url: "https://siriusolymp.ru",
      registrationType: "school",
      deadline: undefined,
      date: "2026-10-20",
      region: "Москва",
    };
    expect(validateRecord(o, ctx)).toEqual({});
    expect(prepareRecord(o)).toMatchObject({ deadline: "expected" });
  });

  it("rejects duplicate ids and a topic from another class", () => {
    const t: Task = {
      ...(newRecord("tasks", ctx) as Task),
      id: "taken",
      title: "Задача",
      prompt: "Сколько?",
      solution: "Столько",
      answer: "abc",
      topicId: "math-5-01",
      grade: 4,
    };
    const e = validateRecord(t, ctx);
    expect(e.id).toMatch(/уже есть/);
    expect(e.topicId).toMatch(/другому классу/);
    expect(e.answer).toMatch(/число/);
  });

  it("checks mock tests", () => {
    const m: MockTest = {
      ...(newRecord("mock-tests", ctx) as MockTest),
      id: "m",
      title: "Тур",
      grade: 5,
      randomize: true,
      taskCount: 3,
      taskIds: ["t1"],
    };
    const e = validateRecord(m, ctx);
    expect(e.taskIds).toMatch(/другому классу/);
    expect(e.taskCount).toBe("Число заданий в попытке – от 1 до 1");
  });

  it("prepares code tasks: the first test becomes the public example", () => {
    const t = prepareRecord({
      ...(newRecord("tasks", ctx) as Task),
      id: "c",
      title: "Код",
      type: "code",
      tests: [{ input: "1", output: "2" }],
    }) as Task;
    expect(t.example).toEqual({ input: "1", output: "2" });
    expect(t.answer).toBeUndefined();
  });
});

describe("CSV", () => {
  it("parses quotes, escaped quotes and CRLF with ; or ,", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a,b\n1,2")).toBe(",");
    expect(parseCsv('﻿a;"b;c";"say ""hi"""\r\n1;2;3\r\n\r\n')).toEqual([
      ["a", "b;c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
    expect(
      parseCsv(
        toCsv([
          ["x;y", 'q"'],
          ["1", "2"],
        ]),
      ),
    ).toEqual([
      ["x;y", 'q"'],
      ["1", "2"],
    ]);
  });
});

describe("olympiad import from a spreadsheet", () => {
  it("accepts the downloadable template", () => {
    const { records, errors } = olympiadsFromCsv(olympiadCsvTemplate());
    expect(errors).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      title: "Олимпиада «Пример» – математика",
      subject: "math",
      grades: [4, 5, 6],
      format: "online",
      region: "",
      registrationType: "link",
      deadline: "2026-10-20",
      date: "2026-10-25",
      registrationStart: "2026-10-01",
      price: 0,
    });
    expect(records[1]).toMatchObject({
      registrationType: "school",
      region: "Москва",
      date: "expected",
      stage: "Школьный этап",
    });
  });

  it("reports errors per row and column in plain Russian", () => {
    const csv = [
      "Название;Предмет;Классы;Формат;Регион;Как участвовать;Ссылка;Регистрация до;Дата",
      "Турнир;Физика;4;Онлайн;;Ссылка;https://a.ru;01.10.2026;10.10.2026",
      "Кубок;Математика;7;Очно;;Ссылка;http://a.ru;31.02.2026;ожидается",
    ].join("\n");
    const { records, errors } = olympiadsFromCsv(csv);
    expect(records).toHaveLength(0);
    const texts = errors.map(formatCsvError);
    expect(texts).toContain("Строка 2, «Предмет»: напишите «Математика» или «Информатика»");
    expect(texts).toContain("Строка 3, «Классы»: перечислите классы через запятую: 4, 5, 6");
    expect(texts).toContain("Строка 3, «Регион»: для очной олимпиады укажите регион");
    expect(texts).toContain("Строка 3, «Ссылка»: ссылка должна начинаться с https://");
    expect(texts).toContain("Строка 3, «Регистрация до»: такой даты нет в календаре");
  });

  it("names missing columns", () => {
    const { errors } = olympiadsFromCsv("Название;Предмет\nА;Математика");
    expect(errors[0].message).toMatch(/«Классы», «Дата»/);
  });

  it("groups regional editions into a series and keeps ids unique", () => {
    const rows = ["Москва", "Москва", "Республика Татарстан"].map(
      (r) => `ВсОШ – математика;Математика;5-6;Онлайн;${r};Через школу;https://s.ru;;20.10.2026`,
    );
    const csv = [
      "Название;Предмет;Классы;Формат;Регион;Как участвовать;Ссылка;Регистрация до;Дата",
      ...rows,
    ].join("\n");
    const { records, errors } = olympiadsFromCsv(csv);
    expect(errors).toEqual([]);
    expect(new Set(records.map((r) => r.id)).size).toBe(3);
    expect(records.every((r) => r.series === "vsosh-matematika-2026")).toBe(true);
    expect(records[0].grades).toEqual([5, 6]);
  });
});
