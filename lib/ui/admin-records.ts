/**
 * Teacher's editor logic: sensible defaults for new records, readable ids from titles and
 * field-level validation.
 *
 * Validation has two layers: friendly checks with messages next to each field, which only
 * repeat rules of the server, and then the server's own validator (`lib/content/validate.mjs`,
 * the same module the publish endpoint runs), whose Russian message is placed at the field it
 * is about. So the editor never rejects what the server accepts, and never lets through what
 * the server would reject.
 */
import type {
  ContentRecord,
  Grade,
  Lesson,
  MockTest,
  Olympiad,
  RecordKind,
  Subject,
  Task,
  Topic,
} from "@/lib/domain/types";
import {
  ContentValidationError,
  isSafeUrl,
  validateLinks,
  validateRecord as validateOnServerRules,
} from "@/lib/content/validate.mjs";
import { regions as ALL_REGIONS } from "@/lib/regions";
import { isExpectedDate, isIsoDay } from "./dates";
import { isNumericAnswer, slugify } from "./format";

export type FieldErrors = Record<string, string>;

export interface EditorContext {
  topics: readonly Pick<Topic, "id" | "grade" | "subject" | "title">[];
  /** Published and draft tasks (deleted ones are not here). */
  tasks: readonly Pick<Task, "id" | "grade" | "subject">[];
  /** Ids already used by other records. */
  existingIds: ReadonlySet<string>;
}

/** Field the teacher has to fix for a message of the server's validator. */
const MESSAGE_FIELDS: [RegExp, string][] = [
  [/^Поле (\w+) /, "$1"],
  [/^ID:/, "id"],
  [/название/i, "title"],
  [/^Укажите классы олимпиады|^Классы олимпиады|^grades:/, "grades"],
  [/^Укажите класс|^grade:/, "grade"],
  [/^Укажите предмет|^Предмет|^subjects/, "subject"],
  [/^Формат олимпиады/, "format"],
  [/^Регион/, "region"],
  [/^series:/, "series"],
  [/^registrationType/, "registrationType"],
  [/^Изображение/, "image"],
  [/^source:/, "source"],
  [/^verifiedAt:/, "verifiedAt"],
  [/^Ссылка/, "url"],
  [/^Стоимость/, "price"],
  [/^Дата проведения/, "date"],
  [/^Укажите дедлайн|^Дедлайн регистрации/, "deadline"],
  [/^Начало регистрации/, "registrationStart"],
  [/^Дата окончания/, "dateEnd"],
  [/^Время пробника/, "minutes"],
  [/случайных заданий/, "taskCount"],
  [/^Укажите тему|^[Тт]ема |чем тема/, "topicId"],
  [/^Выберите тип задания/, "type"],
  [/^Укажите условие/, "prompt"],
  [/^Укажите разбор/, "solution"],
  [/^Укажите подсказку/, "hint"],
  [/^Баллы/, "points"],
  [/ответ/i, "answer"],
  [/тест|input и output|^Пример/, "tests"],
  [/блок/i, "blocks"],
  [/^order/, "order"],
  [/[Зз]адани|^taskIds/, "taskIds"],
];

function fieldOfMessage(message: string): string {
  for (const [re, field] of MESSAGE_FIELDS) {
    const m = re.exec(message);
    if (m) return field.startsWith("$") ? m[1] : field;
  }
  return "form";
}

/** Text of a server rule for the teacher: without the record id prefix. */
function ruleMessage(message: string, id: string): string {
  const text = id && message.startsWith(`${id}: `) ? message.slice(id.length + 2) : message;
  const missing = /^задание (\S+) не найдено$/.exec(text);
  return missing ? deletedTaskMessage(missing[1]) : text.charAt(0).toUpperCase() + text.slice(1);
}

export function deletedTaskMessage(taskId: string): string {
  return `Задание «${taskId}» удалено – уберите его из пробника или восстановите в «Удалённых»`;
}

/** The first rule of the server this record breaks, at its field (empty when it passes). */
export function serverRuleErrors(r: ContentRecord, ctx: EditorContext): FieldErrors {
  try {
    const checked = validateOnServerRules(JSON.parse(JSON.stringify(r)), {
      regions: ALL_REGIONS,
    });
    const known = new Map<string, ContentRecord>();
    for (const t of ctx.topics) known.set(t.id, { kind: "topics", ...t } as Topic);
    for (const t of ctx.tasks) known.set(t.id, { kind: "tasks", ...t } as Task);
    validateLinks([checked], known);
    return {};
  } catch (e) {
    if (!(e instanceof ContentValidationError)) throw e;
    return errorsFromServerMessage(e.message, r.id);
  }
}

/** A validation message of the server (or of its validator) placed at its field. */
export function errorsFromServerMessage(message: string, recordId: string): FieldErrors {
  const text = ruleMessage(message, recordId);
  return { [fieldOfMessage(text)]: text };
}

export function uniqueId(base: string, existing: ReadonlySet<string>): string {
  const clean = slugify(base) || "material";
  if (!existing.has(clean)) return clean;
  for (let i = 2; ; i++) {
    const candidate = `${clean}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export function newRecord(
  kind: RecordKind,
  ctx: Pick<EditorContext, "topics">,
  defaults: { grade?: Grade; subject?: Subject } = {},
): ContentRecord {
  const grade = defaults.grade ?? 4;
  const subject = defaults.subject ?? "math";
  const topic = ctx.topics.find((t) => t.grade === grade && t.subject === subject);
  switch (kind) {
    case "olympiads":
      return {
        id: "",
        kind,
        title: "",
        subject,
        grades: [4, 5, 6],
        format: "online",
        region: "",
        registrationType: "link",
        url: "",
        date: "expected",
        deadline: "expected",
        price: 0,
      } satisfies Olympiad;
    case "topics":
      return { id: "", kind, title: "", grade, subject, order: 1, description: "" } satisfies Topic;
    case "lessons":
      return {
        id: "",
        kind,
        title: "",
        grade,
        subject,
        topicId: topic?.id ?? "",
        order: 1,
        blocks: [{ type: "text", value: "" }],
      } satisfies Lesson;
    case "tasks":
      return {
        id: "",
        kind,
        title: "",
        grade,
        subject,
        topicId: topic?.id ?? "",
        order: 1,
        type: "number",
        prompt: "",
        answer: "",
        solution: "",
        hint: "",
        points: 1,
        tests: [{ input: "", output: "" }],
      } satisfies Task;
    case "mock-tests":
      return {
        id: "",
        kind,
        title: "",
        grade,
        subject,
        olympiad: "",
        minutes: 40,
        taskIds: [],
        randomize: false,
        taskCount: 10,
      } satisfies MockTest;
  }
}

const safeUrl = (v: string | undefined) => isSafeUrl(v ?? "");

/**
 * Friendly checks of an olympiad. Each one repeats a rule of the server: an offline olympiad
 * may be all-Russia (held in many cities), a link may be added later, and registration may
 * stay open until the last day of a multi-day olympiad.
 */
function checkOlympiad(r: Olympiad, e: FieldErrors) {
  if (!r.grades?.length) e.grades = "Отметьте хотя бы один класс";
  if (r.region && !ALL_REGIONS.includes(r.region)) e.region = "Выберите регион из списка";
  if (r.url && !safeUrl(r.url)) e.url = "Ссылка должна начинаться с https://";
  if (!isIsoDay(r.date) && !isExpectedDate(r.date))
    e.date = "Укажите дату или отметьте «Дата ещё не объявлена»";
  if (r.deadline && !isIsoDay(r.deadline) && !isExpectedDate(r.deadline))
    e.deadline = "Укажите дату или отметьте «Срок ещё не объявлен»";
  const lastDay = isIsoDay(r.dateEnd) ? r.dateEnd : isIsoDay(r.date) ? r.date : null;
  if (isIsoDay(r.deadline) && lastDay && r.deadline > lastDay)
    e.deadline = r.dateEnd
      ? "Регистрация не может заканчиваться позже последнего дня олимпиады"
      : "Регистрация не может заканчиваться позже дня олимпиады";
  if (isIsoDay(r.registrationStart) && isIsoDay(r.deadline) && r.registrationStart > r.deadline)
    e.registrationStart = "Начало регистрации позже её окончания";
  if (r.dateEnd && isIsoDay(r.date) && isIsoDay(r.dateEnd) && r.dateEnd < r.date)
    e.dateEnd = "Дата окончания раньше даты начала";
  if (r.price !== undefined && (!Number.isFinite(r.price) || r.price < 0))
    e.price = "Стоимость – число рублей, 0 – бесплатно";
  if (!safeUrl(r.image)) e.image = "Ссылка на картинку должна начинаться с https://";
  if (r.source && !isSafeUrl(r.source, { allowLocal: false }))
    e.source = "Ссылка должна начинаться с https://";
}

function checkTopicLink(r: Lesson | Task, ctx: EditorContext, e: FieldErrors) {
  const topic = ctx.topics.find((t) => t.id === r.topicId);
  if (!r.topicId || !topic) e.topicId = "Выберите тему";
  else if (topic.grade !== r.grade || topic.subject !== r.subject)
    e.topicId = "Тема относится к другому классу или предмету – выберите тему заново";
}

/** Field errors of a record prepared with `prepareRecord`; `{}` when it can be saved. */
export function validateRecord(r: ContentRecord, ctx: EditorContext): FieldErrors {
  const e = friendlyErrors(r, ctx);
  return Object.keys(e).length ? e : serverRuleErrors(r, ctx);
}

function friendlyErrors(r: ContentRecord, ctx: EditorContext): FieldErrors {
  const e: FieldErrors = {};
  if (!r.title?.trim()) e.title = "Впишите название";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(r.id || "")) e.id = "Код: латинские буквы, цифры и дефис";
  else if (ctx.existingIds.has(r.id)) e.id = "Такой код уже есть – придумайте другой";
  switch (r.kind) {
    case "olympiads":
      checkOlympiad(r, e);
      break;
    case "topics":
      if (!Number.isFinite(r.order)) e.order = "Укажите номер по порядку";
      break;
    case "lessons":
      checkTopicLink(r, ctx, e);
      // Empty blocks are dropped by `prepareRecord`.
      if (!r.blocks?.length) e.blocks = "Добавьте хотя бы один блок";
      r.blocks?.forEach((b, i) => {
        if (["image", "video", "link"].includes(b.type) && !safeUrl(b.value))
          e[`blocks.${i}`] = "Ссылка должна начинаться с https:// (или загрузите файл)";
      });
      break;
    case "tasks":
      checkTopicLink(r, ctx, e);
      if (!r.prompt?.trim()) e.prompt = "Впишите условие задачи";
      if (!r.solution?.trim()) e.solution = "Впишите разбор – ребёнок увидит его после попытки";
      if (r.type === "number" && !isNumericAnswer(String(r.answer ?? "")))
        e.answer = "Правильный ответ – число, например 12 или 0,5";
      if (r.points !== undefined && (!Number.isFinite(r.points) || r.points < 0))
        e.points = "Баллы – число от 0";
      // Empty test rows are dropped by `prepareRecord`.
      if (r.type === "code" && !r.tests?.length)
        e.tests = "Добавьте хотя бы один тест: вход и правильный вывод";
      break;
    case "mock-tests": {
      if (!(r.minutes > 0)) e.minutes = "Время – больше 0 минут";
      if (!r.taskIds.length) e.taskIds = "Выберите задания для пробника";
      if (new Set(r.taskIds).size !== r.taskIds.length) e.taskIds = "Задания повторяются";
      const missing = r.taskIds.filter((id) => !ctx.tasks.some((x) => x.id === id));
      const wrong = r.taskIds.filter((id) => {
        const t = ctx.tasks.find((x) => x.id === id);
        return t && (t.grade !== r.grade || t.subject !== r.subject);
      });
      if (missing.length) e.taskIds = deletedTaskMessage(missing[0]);
      else if (wrong.length)
        e.taskIds = "Часть заданий относится к другому классу или предмету – уберите их";
      if (
        r.randomize &&
        (!(r.taskCount && r.taskCount > 0) || (r.taskCount ?? 0) > r.taskIds.length)
      )
        e.taskCount = `Число заданий в попытке – от 1 до ${r.taskIds.length || 1}`;
      break;
    }
  }
  return e;
}

/** Final touches before sending: trimmed strings, code example from the first test. */
export function prepareRecord(r: ContentRecord): ContentRecord {
  const out = { ...r, title: r.title.trim() } as ContentRecord;
  if (out.kind === "lessons") out.blocks = (out.blocks ?? []).filter((b) => b.value?.trim());
  if (out.kind === "tasks") {
    // A test row left completely empty is not a test.
    if (out.tests) out.tests = out.tests.filter((t) => t.input.trim() || t.output.trim());
    if (out.type === "code" && out.tests?.length) out.example = out.tests[0];
    if (out.type !== "code") delete out.tests;
    if (out.type !== "number") delete out.answer;
  }
  if (out.kind === "olympiads") {
    // Older servers require a deadline; «expected» means «not announced».
    if (!out.deadline) out.deadline = "expected";
    for (const key of [
      "dateEnd",
      "registrationStart",
      "stage",
      "series",
      "source",
      "verifiedAt",
      "description",
      "image",
    ] as const)
      if (!out[key]) delete out[key];
  }
  return out;
}

export const FIELD_ORDER = [
  "form",
  "title",
  "subject",
  "grades",
  "grade",
  "topicId",
  "type",
  "prompt",
  "answer",
  "solution",
  "points",
  "tests",
  "format",
  "region",
  "registrationType",
  "url",
  "registrationStart",
  "deadline",
  "date",
  "dateEnd",
  "price",
  "image",
  "source",
  "blocks",
  "minutes",
  "taskIds",
  "taskCount",
  "order",
  "id",
];

/** First field with an error, in on-screen order – to scroll to it. */
export function firstErrorField(errors: FieldErrors): string | undefined {
  const keys = Object.keys(errors);
  const byOrder = (k: string) => {
    const i = FIELD_ORDER.indexOf(k.split(".")[0]);
    return i < 0 ? FIELD_ORDER.length : i;
  };
  return keys.sort((a, b) => byOrder(a) - byOrder(b))[0];
}
