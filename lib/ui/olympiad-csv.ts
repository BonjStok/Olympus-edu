/**
 * Olympiad import from a spreadsheet (CSV) with Russian column names, for teachers.
 * Dates as `дд.мм.гггг` (or `гггг-мм-дд`) or «ожидается». Errors name the row and column.
 */
import type { Grade, Olympiad, Subject } from "@/lib/domain/types";
import { regions as ALL_REGIONS } from "@/lib/regions";
import { parseCsv, toCsv } from "./csv";
import { isIsoDay } from "./dates";
import { slugify } from "./format";
import { normalizeQuery, sameRegion } from "./regions";

export const OLYMPIAD_COLUMNS = [
  "Название",
  "Предмет",
  "Классы",
  "Формат",
  "Регион",
  "Этап",
  "Как участвовать",
  "Ссылка",
  "Начало регистрации",
  "Регистрация до",
  "Дата",
  "Дата окончания",
  "Стоимость",
  "Описание",
  "Источник",
] as const;

type Column = (typeof OLYMPIAD_COLUMNS)[number];
const REQUIRED: Column[] = ["Название", "Предмет", "Классы", "Дата"];

export interface CsvRowError {
  /** 1-based line in the file (the header is line 1). */
  row: number;
  column?: string;
  message: string;
}

export interface CsvImportResult {
  records: Olympiad[];
  errors: CsvRowError[];
}

export function olympiadCsvTemplate(): string {
  return toCsv([
    [...OLYMPIAD_COLUMNS],
    [
      "Олимпиада «Пример» – математика",
      "Математика",
      "4, 5, 6",
      "Онлайн",
      "",
      "",
      "Ссылка",
      "https://example.ru/olympiad",
      "01.10.2026",
      "20.10.2026",
      "25.10.2026",
      "",
      "0",
      "Короткое описание для детей",
      "https://example.ru/olympiad",
    ],
    [
      "ВсОШ – математика – школьный этап",
      "Математика",
      "5, 6",
      "Онлайн",
      "Москва",
      "Школьный этап",
      "Через школу",
      "https://siriusolymp.ru",
      "",
      "",
      "ожидается",
      "",
      "0",
      "",
      "",
    ],
  ]);
}

const norm = (s: string) => normalizeQuery(s);

function parseDate(raw: string): { value?: string; expected?: boolean; error?: string } {
  const v = raw.trim();
  if (!v) return {};
  if (["ожидается", "expected", "уточняется", "нет даты"].includes(v.toLowerCase()))
    return { expected: true };
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const iso = ru ? `${ru[3]}-${ru[2].padStart(2, "0")}-${ru[1].padStart(2, "0")}` : v;
  if (!isIsoDay(iso))
    return { error: "дата в формате дд.мм.гггг, например 20.10.2026, или «ожидается»" };
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso)
    return { error: "такой даты нет в календаре" };
  return { value: iso };
}

function parseSubject(raw: string): Subject | null {
  const v = norm(raw);
  if (["математика", "math", "мат"].includes(v)) return "math";
  if (["информатика", "info", "инф", "программирование"].includes(v)) return "info";
  return null;
}

function parseGrades(raw: string): Grade[] | null {
  const nums = raw
    .replace(/классы?|кл\.?/gi, "")
    .split(/[,;\s/]+/)
    .flatMap((part) => {
      const range = /^(\d)[-–](\d)$/.exec(part.trim());
      if (range) {
        const out: number[] = [];
        for (let g = Number(range[1]); g <= Number(range[2]); g++) out.push(g);
        return out;
      }
      return part.trim() ? [Number(part.trim())] : [];
    });
  if (!nums.length || nums.some((n) => ![4, 5, 6].includes(n))) return null;
  return [...new Set(nums)].sort() as Grade[];
}

function parseFormat(raw: string): "online" | "offline" | null {
  const v = norm(raw);
  if (!v || ["онлайн", "online", "дистанционно", "заочно"].includes(v)) return "online";
  if (["очно", "офлайн", "offline", "оффлайн"].includes(v)) return "offline";
  return null;
}

function parseRegion(raw: string): string | null {
  const v = norm(raw);
  if (!v || ["вся россия", "россия", "все регионы", "рф"].includes(v)) return "";
  return (
    ALL_REGIONS.find((r) => norm(r) === v) ?? ALL_REGIONS.find((r) => sameRegion(raw, r)) ?? null
  );
}

function parseRegistration(raw: string): "link" | "school" | null {
  const v = norm(raw);
  if (!v || v.startsWith("ссылк") || v.includes("сайт") || v === "link") return "link";
  if (v.includes("школ") || v === "school") return "school";
  return null;
}

/** Converts CSV text into olympiad records; rows with errors are skipped and reported. */
export function olympiadsFromCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const errors: CsvRowError[] = [];
  if (!rows.length) return { records: [], errors: [{ row: 1, message: "Файл пустой" }] };
  const header = rows[0].map((h) => h.trim());
  const col = (name: Column) => header.findIndex((h) => norm(h) === norm(name));
  const missing = REQUIRED.filter((c) => col(c) < 0);
  if (missing.length)
    return {
      records: [],
      errors: [
        {
          row: 1,
          message: `Не хватает столбцов: ${missing.map((m) => `«${m}»`).join(", ")}. Скачайте шаблон и сравните заголовки`,
        },
      ],
    };

  const records: Olympiad[] = [];
  const ids = new Map<string, number>();
  const titleRegions = new Map<string, number>();

  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (name: Column) => {
      const idx = col(name);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const fail = (column: Column, message: string) => errors.push({ row: line, column, message });
    const before = errors.length;

    const title = get("Название");
    if (!title) fail("Название", "впишите название олимпиады");
    const subject = parseSubject(get("Предмет"));
    if (!subject) fail("Предмет", "напишите «Математика» или «Информатика»");
    const grades = parseGrades(get("Классы"));
    if (!grades) fail("Классы", "перечислите классы через запятую: 4, 5, 6");
    const format = parseFormat(get("Формат"));
    if (!format) fail("Формат", "напишите «Онлайн» или «Очно»");
    const region = parseRegion(get("Регион"));
    if (region === null)
      fail(
        "Регион",
        "напишите регион как в списке (например, «Москва», «Республика Татарстан») или оставьте пустым для всей России",
      );
    if (format === "offline" && region === "") fail("Регион", "для очной олимпиады укажите регион");
    const registrationType = parseRegistration(get("Как участвовать"));
    if (!registrationType) fail("Как участвовать", "напишите «Ссылка» или «Через школу»");
    const url = get("Ссылка");
    if (url && !/^https:\/\//i.test(url)) fail("Ссылка", "ссылка должна начинаться с https://");
    if (!url && registrationType === "link") fail("Ссылка", "добавьте ссылку на регистрацию");

    const date = parseDate(get("Дата"));
    if (date.error) fail("Дата", date.error);
    if (!date.value && !date.expected) fail("Дата", "укажите дату или напишите «ожидается»");
    const dateEnd = parseDate(get("Дата окончания"));
    if (dateEnd.error) fail("Дата окончания", dateEnd.error);
    const deadline = parseDate(get("Регистрация до"));
    if (deadline.error) fail("Регистрация до", deadline.error);
    const start = parseDate(get("Начало регистрации"));
    if (start.error) fail("Начало регистрации", start.error);
    if (deadline.value && date.value && deadline.value > date.value)
      fail("Регистрация до", "регистрация не может заканчиваться позже дня олимпиады");
    if (dateEnd.value && date.value && dateEnd.value < date.value)
      fail("Дата окончания", "дата окончания раньше даты начала");

    const priceRaw = get("Стоимость")
      .replace(/\s|₽|руб\.?/gi, "")
      .replace(",", ".");
    const price = priceRaw ? Number(priceRaw) : 0;
    if (!Number.isFinite(price) || price < 0)
      fail("Стоимость", "укажите число рублей, 0 – бесплатно");
    const source = get("Источник");
    if (source && !/^https:\/\//i.test(source))
      fail("Источник", "ссылка должна начинаться с https://");

    if (
      errors.length > before ||
      !subject ||
      !grades ||
      !format ||
      region === null ||
      !registrationType
    )
      return;

    const year = (date.value ?? deadline.value ?? "").slice(0, 4) || "tbd";
    const base = [slugify(title).slice(0, 55), region ? slugify(region).slice(0, 24) : "", year]
      .filter(Boolean)
      .join("-");
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    const id = n > 1 ? `${base}-${n}` : base;
    const titleKey = `${norm(title)}|${subject}|${year}`;
    titleRegions.set(titleKey, (titleRegions.get(titleKey) ?? 0) + (region ? 1 : 0));

    const record: Olympiad = {
      id,
      kind: "olympiads",
      title,
      subject,
      grades,
      format,
      region,
      registrationType,
      url,
      date: date.value ?? "expected",
      // Older servers require a deadline; «expected» means «not announced».
      deadline: deadline.value ?? "expected",
      price,
    };
    const stage = get("Этап");
    if (stage) record.stage = stage;
    if (dateEnd.value) record.dateEnd = dateEnd.value;
    if (start.value) record.registrationStart = start.value;
    const description = get("Описание");
    if (description) record.description = description;
    if (source) record.source = source;
    records.push(record);
  });

  // Regional editions of the same olympiad form a series (one card when no region is chosen).
  for (const r of records) {
    const year =
      (isIsoDay(r.date) ? r.date : isIsoDay(r.deadline) ? r.deadline : "").slice(0, 4) || "tbd";
    const key = `${norm(r.title)}|${r.subject}|${year}`;
    if (r.region && (titleRegions.get(key) ?? 0) >= 2)
      r.series = `${slugify(r.title).slice(0, 60)}-${year}`;
  }
  return { records, errors };
}

export function formatCsvError(e: CsvRowError): string {
  return e.column
    ? `Строка ${e.row}, «${e.column}»: ${e.message}`
    : `Строка ${e.row}: ${e.message}`;
}
