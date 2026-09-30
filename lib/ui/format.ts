/** Small human-readable labels shared by child and teacher screens. */
import type {
  CodeLanguage,
  Grade,
  Olympiad,
  RecordKind,
  Subject,
  TaskType,
} from "@/lib/domain/types";

export const SUBJECT_LABEL: Record<Subject, string> = {
  math: "Математика",
  info: "Информатика",
};

export const SUBJECT_LABEL_LOWER: Record<Subject, string> = {
  math: "математика",
  info: "информатика",
};

export const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  python: "Python",
  cpp: "C++",
  java: "Java",
  javascript: "JavaScript",
  kotlin: "Kotlin",
  pascal: "Pascal",
};

export const KIND_LABEL: Record<RecordKind, string> = {
  olympiads: "Олимпиады",
  topics: "Темы",
  lessons: "Уроки",
  tasks: "Задания",
  "mock-tests": "Пробники",
};

export const KIND_LABEL_ONE: Record<RecordKind, string> = {
  olympiads: "олимпиада",
  topics: "тема",
  lessons: "урок",
  tasks: "задание",
  "mock-tests": "пробник",
};

/** «Добавить олимпиаду». */
export const KIND_LABEL_ACC: Record<RecordKind, string> = {
  olympiads: "олимпиаду",
  topics: "тему",
  lessons: "урок",
  tasks: "задание",
  "mock-tests": "пробник",
};

export const KIND_LABEL_NEW: Record<RecordKind, string> = {
  olympiads: "Новая олимпиада",
  topics: "Новая тема",
  lessons: "Новый урок",
  tasks: "Новое задание",
  "mock-tests": "Новый пробник",
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  number: "Ответ числом",
  proof: "Рассуждение (самопроверка)",
  code: "Программа",
};

export const GRADES: readonly Grade[] = [4, 5, 6];

/** «4, 5 и 6 классы», «6 класс». */
export function gradesLabel(grades: readonly number[] | undefined): string {
  const g = [...new Set(grades ?? [])].sort((a, b) => a - b);
  if (!g.length) return "Классы уточняются";
  if (g.length === 1) return `${g[0]} класс`;
  const isRange = g.every((v, i) => i === 0 || v === g[i - 1] + 1);
  if (isRange && g.length > 2) return `${g[0]}–${g[g.length - 1]} классы`;
  return `${g.slice(0, -1).join(", ")} и ${g[g.length - 1]} классы`;
}

export function subjectsLabel(e: Pick<Olympiad, "subject" | "subjects">): string {
  const all = new Set([e.subject, ...(e.subjects ?? [])]);
  return all.size > 1 ? "Математика и информатика" : (SUBJECT_LABEL[e.subject] ?? "Олимпиада");
}

/** «Бесплатно», «160 ₽»; `undefined` when the price is unknown (don't show it). */
export function priceLabel(price?: number): string | undefined {
  if (price === undefined || price === null || !Number.isFinite(price)) return undefined;
  if (price === 0) return "Бесплатно";
  return `${price.toLocaleString("ru-RU")} ₽`;
}

/** «Задание 3» titles repeat the number shown next to them; hide such generic titles. */
export function isGenericTaskTitle(title: string): boolean {
  return /^(задание|задача)\s*№?\s*\d+$/i.test(title.trim());
}

/** Accepts «12», «-3», «0,5», «0.5». */
export function isNumericAnswer(value: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim());
}

/** Latin slug for record ids: «Чётность и нечётность» → «chetnost-i-nechetnost». */
export function slugify(text: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  return text
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
