// Content validation shared by the build step (`scripts/compile-content.mjs`) and the admin
// publish/import path on the server. Plain ESM with JSDoc types so that Node scripts can use it
// without a TypeScript toolchain; TypeScript code imports it through `allowJs`.
//
// All messages are in Russian: they are shown to teachers in the admin panel as is.

/** @typedef {import("../domain/types").ContentRecord} ContentRecord */
/** @typedef {import("../domain/types").Olympiad} Olympiad */
/** @typedef {import("../domain/types").RecordKind} RecordKind */

export const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const SERIES_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NUMBER_ANSWER_PATTERN = /^[-+]?\d+(?:[.,]\d+)?$/;

/** @type {readonly RecordKind[]} */
export const RECORD_KINDS = ["olympiads", "topics", "lessons", "tasks", "mock-tests"];
export const SUBJECTS = ["math", "info"];
export const GRADES = [4, 5, 6];
export const TASK_TYPES = ["number", "proof", "code"];
export const OLYMPIAD_FORMATS = ["online", "offline"];
export const REGISTRATION_TYPES = ["link", "school"];
export const LESSON_BLOCK_TYPES = [
  "text",
  "example",
  "formula",
  "image",
  "video",
  "link",
  "list",
  "table",
  "code",
];
const URL_BLOCK_TYPES = ["image", "video", "link"];
const EXPECTED_MARKERS = ["expected", "pending", "ожидается"];
const LOCAL_URL_PREFIXES = ["/api/media/", "/olympiad-default.png", "/olympiad-default.webp"];

/** Size limits for text fields. They are generous: the goal is to reject garbage, not content. */
export const CONTENT_LIMITS = Object.freeze({
  title: 300,
  shortText: 300,
  description: 5_000,
  richText: 50_000,
  url: 2_048,
  blocks: 200,
  taskIds: 200,
  tests: 20,
  testText: 100_000,
  minutes: 600,
  points: 1_000,
  price: 1_000_000,
});

export class ContentValidationError extends Error {
  /**
   * @param {string} message
   * @param {{ recordId?: string; code?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "ContentValidationError";
    this.recordId = details.recordId;
    this.code = details.code || "VALIDATION_ERROR";
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `YYYY-MM-DD` that is also a real calendar day. */
export function isCalendarDate(/** @type {unknown} */ value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Maps «ожидается» / «pending» / «expected» (any case) to the canonical `expected` marker. */
export function normalizeEventDate(/** @type {unknown} */ value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return EXPECTED_MARKERS.includes(trimmed.toLowerCase()) ? "expected" : trimmed;
}

/**
 * Links in content must be HTTPS. Local media uploaded through the admin panel and the default
 * olympiad picture are allowed as relative paths. An empty string means "no link".
 * @param {unknown} value
 * @param {{ allowLocal?: boolean }} [options]
 */
export function isSafeUrl(value, options = {}) {
  const { allowLocal = true } = options;
  if (value === "" || value === undefined || value === null) return true;
  if (typeof value !== "string" || value.length > CONTENT_LIMITS.url) return false;
  if (allowLocal && LOCAL_URL_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return !value.includes("..") && !value.includes("//");
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Normalised identity of an olympiad for duplicate detection: case, «ё», quotes, dashes and
 * spacing differences in the title do not make two calendar entries different.
 */
export function normalizeTitle(/** @type {unknown} */ title) {
  return String(title ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'“”„`]/g, "")
    // Every dash from U+2010 to U+2015 (hyphen … en dash, em dash, horizontal bar).
    .replace(/[\u2010-\u2015-]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/[.,:;!?()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {Pick<Olympiad, "title" | "region" | "date">} olympiad */
export function olympiadIdentity(olympiad) {
  return [normalizeTitle(olympiad.title), olympiad.region || "", olympiad.date || ""].join("|");
}

/**
 * Finds the first olympiad in `candidates` that duplicates another candidate or an `existing`
 * olympiad with a different id.
 * @param {Olympiad[]} candidates
 * @param {Iterable<Olympiad>} [existing]
 * @returns {{ record: Olympiad; duplicateOf: Olympiad } | null}
 */
export function findDuplicateOlympiad(candidates, existing = []) {
  /** @type {Map<string, Olympiad>} */
  const seen = new Map();
  const candidateIds = new Set(candidates.map((record) => record.id));
  for (const record of existing) {
    // Records that are being replaced by this batch are compared in their new form.
    if (record.kind === "olympiads" && !candidateIds.has(record.id))
      seen.set(olympiadIdentity(record), record);
  }
  for (const record of candidates) {
    if (record.kind !== "olympiads") continue;
    const key = olympiadIdentity(record);
    const other = seen.get(key);
    if (other && other.id !== record.id) return { record, duplicateOf: other };
    seen.set(key, record);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-record validation
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {number} max
 * @param {string} label
 * @param {(message: string) => never} fail
 * @param {{ required?: boolean }} [options]
 */
function checkText(record, field, max, label, fail, options = {}) {
  const value = record[field];
  if (value === undefined || value === null) {
    if (options.required) fail(`Укажите ${label}`);
    delete record[field];
    return;
  }
  if (typeof value !== "string") fail(`Поле ${field} должно быть строкой`);
  if (options.required && !value.trim()) fail(`Укажите ${label}`);
  if (value.length > max) fail(`Поле ${field} длиннее ${max} символов`);
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} field
 * @param {(message: string) => never} fail
 */
function checkBoolean(record, field, fail) {
  if (record[field] === undefined) return;
  if (typeof record[field] !== "boolean") fail(`Поле ${field} должно быть true или false`);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {(message: string) => never} fail
 * @returns {number}
 */
function toGrade(value, field, fail) {
  const grade = Number(value);
  if (typeof value === "boolean" || !GRADES.includes(grade)) fail(`${field}: класс от 4 до 6`);
  return grade;
}

/**
 * Validates one content record and returns its normalised copy (numbers instead of numeric
 * strings, canonical `expected` dates). Cross-record rules live in `validateLinks`.
 *
 * @param {unknown} input
 * @param {{ regions: readonly string[]; kind?: RecordKind }} options
 * @returns {ContentRecord}
 */
export function validateRecord(input, options) {
  if (!isObject(input)) throw new ContentValidationError("Материал должен быть JSON-объектом");
  /** @type {Record<string, unknown>} */
  const r = { ...input };
  if (options.kind) r.kind = options.kind;
  const recordId = typeof r.id === "string" ? r.id : undefined;
  /** @type {(message: string) => never} */
  const fail = (message) => {
    const prefix = recordId && ID_PATTERN.test(recordId) ? `${recordId}: ` : "";
    throw new ContentValidationError(prefix + message, { recordId });
  };

  if (typeof r.kind !== "string" || !RECORD_KINDS.includes(/** @type {RecordKind} */ (r.kind)))
    fail("Неизвестный тип материала");
  if (typeof r.id !== "string" || !ID_PATTERN.test(r.id))
    fail("ID: латинские буквы, цифры, _ или - (до 100 символов)");
  checkText(r, "title", CONTENT_LIMITS.title, "название", fail, { required: true });
  checkBoolean(r, "demo", fail);
  checkBoolean(r, "unpublished", fail);
  if (r.grade !== undefined) r.grade = toGrade(r.grade, "grade", fail);
  if (r.subject !== undefined && !SUBJECTS.includes(/** @type {string} */ (r.subject)))
    fail("Предмет должен быть math или info");
  if (r.order !== undefined) {
    const order = Number(r.order);
    if (typeof r.order === "boolean" || !Number.isInteger(order) || order < 0)
      fail("order должен быть целым неотрицательным числом");
    r.order = order;
  }

  switch (r.kind) {
    case "topics":
      validateTopic(r, fail);
      break;
    case "lessons":
      validateLesson(r, fail);
      break;
    case "tasks":
      validateTask(r, fail);
      break;
    case "mock-tests":
      validateMockTest(r, fail);
      break;
    case "olympiads":
      validateOlympiad(r, options.regions, fail);
      break;
  }
  return /** @type {ContentRecord} */ (/** @type {unknown} */ (r));
}

/**
 * @param {Record<string, unknown>} r
 * @param {(message: string) => never} fail
 */
function validateTopic(r, fail) {
  if (r.grade === undefined) fail("Укажите класс темы");
  if (r.subject === undefined) fail("Укажите предмет темы");
  checkText(r, "description", CONTENT_LIMITS.description, "описание", fail);
}

/**
 * @param {Record<string, unknown>} r
 * @param {(message: string) => never} fail
 */
function validateLesson(r, fail) {
  if (typeof r.topicId !== "string" || !ID_PATTERN.test(r.topicId)) fail("Укажите тему урока");
  if (!Array.isArray(r.blocks) || !r.blocks.length) fail("Добавьте хотя бы один блок урока");
  if (r.blocks.length > CONTENT_LIMITS.blocks)
    fail(`В уроке не больше ${CONTENT_LIMITS.blocks} блоков`);
  for (const block of r.blocks) {
    if (!isObject(block)) fail("Блок урока должен быть объектом");
    if (!LESSON_BLOCK_TYPES.includes(/** @type {string} */ (block.type)))
      fail(`Неизвестный тип блока урока: ${String(block.type)}`);
    if (typeof block.value !== "string") fail("Содержимое блока урока должно быть строкой");
    if (block.value.length > CONTENT_LIMITS.richText) fail("Блок урока слишком длинный");
    if (block.caption !== undefined && typeof block.caption !== "string")
      fail("Подпись блока должна быть строкой");
    if (URL_BLOCK_TYPES.includes(block.type) && !isSafeUrl(block.value))
      fail(`Блок ${block.type}: ссылка должна начинаться с https://`);
  }
}

/**
 * @param {Record<string, unknown>} r
 * @param {(message: string) => never} fail
 */
function validateTask(r, fail) {
  if (typeof r.topicId !== "string" || !ID_PATTERN.test(r.topicId)) fail("Укажите тему задания");
  if (!TASK_TYPES.includes(/** @type {string} */ (r.type))) fail("Выберите тип задания");
  checkText(r, "prompt", CONTENT_LIMITS.richText, "условие", fail, { required: true });
  checkText(r, "solution", CONTENT_LIMITS.richText, "разбор", fail, { required: true });
  checkText(r, "hint", CONTENT_LIMITS.description, "подсказку", fail);
  if (r.points !== undefined) {
    const points = Number(r.points);
    if (typeof r.points === "boolean" || !Number.isFinite(points) || points < 0)
      fail("Баллы не могут быть отрицательными");
    if (points > CONTENT_LIMITS.points) fail(`Баллы: не больше ${CONTENT_LIMITS.points}`);
    r.points = points;
  }
  if (r.answer !== undefined && r.answer !== null && typeof r.answer !== "string") {
    if (typeof r.answer === "number" && Number.isFinite(r.answer)) r.answer = String(r.answer);
    else fail("Ответ должен быть строкой");
  }
  if (r.type === "number" && !NUMBER_ANSWER_PATTERN.test(String(r.answer ?? "").trim()))
    fail("Введите числовой правильный ответ");
  if (typeof r.answer === "string" && r.answer.length > CONTENT_LIMITS.shortText)
    fail("Ответ слишком длинный");
  /** @param {unknown} test */
  const validTest = (test) =>
    isObject(test) &&
    typeof test.input === "string" &&
    typeof test.output === "string" &&
    test.input.length <= CONTENT_LIMITS.testText &&
    test.output.length <= CONTENT_LIMITS.testText;
  if (r.type === "code") {
    if (!Array.isArray(r.tests) || !r.tests.length)
      fail("Добавьте вход и правильный выход для тестов");
    if (r.tests.length > CONTENT_LIMITS.tests)
      fail(`Не больше ${CONTENT_LIMITS.tests} тестов на задание`);
    if (!r.tests.every(validTest)) fail("Каждый тест должен содержать строковые input и output");
  } else if (r.tests !== undefined) {
    if (!Array.isArray(r.tests) || !r.tests.every(validTest))
      fail("Каждый тест должен содержать строковые input и output");
  }
  if (r.example !== undefined && r.example !== null && !validTest(r.example))
    fail("Пример должен содержать строковые input и output");
}

/**
 * @param {Record<string, unknown>} r
 * @param {(message: string) => never} fail
 */
function validateMockTest(r, fail) {
  if (r.grade === undefined) fail("Укажите класс пробника");
  if (r.subject === undefined) fail("Укажите предмет пробника");
  checkText(r, "olympiad", CONTENT_LIMITS.shortText, "олимпиаду", fail);
  const minutes = Number(r.minutes);
  if (typeof r.minutes === "boolean" || !(minutes > 0) || minutes > CONTENT_LIMITS.minutes)
    fail(`Время пробника: от 1 до ${CONTENT_LIMITS.minutes} минут`);
  r.minutes = minutes;
  if (!Array.isArray(r.taskIds) || !r.taskIds.length)
    fail("Нужно время и хотя бы одно задание");
  if (r.taskIds.length > CONTENT_LIMITS.taskIds)
    fail(`В пробнике не больше ${CONTENT_LIMITS.taskIds} заданий`);
  if (!r.taskIds.every((id) => typeof id === "string" && ID_PATTERN.test(id)))
    fail("taskIds должны быть ID заданий");
  if (new Set(r.taskIds).size !== r.taskIds.length)
    fail("В пробнике не должно быть повторяющихся заданий");
  checkBoolean(r, "randomize", fail);
  if (r.taskCount !== undefined) {
    const count = Number(r.taskCount);
    if (typeof r.taskCount === "boolean" || !Number.isInteger(count))
      fail("Проверьте количество случайных заданий");
    r.taskCount = count;
  }
  if (
    r.randomize &&
    (!(Number(r.taskCount) > 0) || Number(r.taskCount) > /** @type {unknown[]} */ (r.taskIds).length)
  )
    fail("Проверьте количество случайных заданий");
}

/**
 * Olympiad schema v2 (see `Olympiad` in lib/domain/types.ts).
 * @param {Record<string, unknown>} r
 * @param {readonly string[]} regions
 * @param {(message: string) => never} fail
 */
function validateOlympiad(r, regions, fail) {
  if (r.subject === undefined) fail("Укажите предмет олимпиады");
  if (r.subjects !== undefined) {
    if (
      !Array.isArray(r.subjects) ||
      !r.subjects.length ||
      r.subjects.some((s) => !SUBJECTS.includes(s)) ||
      new Set(r.subjects).size !== r.subjects.length
    )
      fail("subjects: список без повторов из math и info");
    if (!r.subjects.includes(r.subject)) fail("subjects должен включать основной предмет subject");
  }
  if (!Array.isArray(r.grades) || !r.grades.length)
    fail("Укажите классы олимпиады: 4, 5 или 6");
  r.grades = r.grades.map((grade) => toGrade(grade, "grades", fail));
  if (new Set(r.grades).size !== r.grades.length) fail("Классы олимпиады не должны повторяться");
  if (!OLYMPIAD_FORMATS.includes(/** @type {string} */ (r.format)))
    fail("Формат олимпиады должен быть online или offline");

  if (r.region === undefined || r.region === null) r.region = "";
  if (typeof r.region !== "string") fail("Регион должен быть строкой");
  if (r.region !== "" && !regions.includes(r.region))
    fail(`Регион «${r.region}» не найден в справочнике регионов`);

  if (r.series !== undefined) {
    if (typeof r.series !== "string" || r.series.length > 100 || !SERIES_PATTERN.test(r.series))
      fail("series: латинские строчные буквы, цифры и дефисы, например vsosh-school-2026-math");
  }
  checkText(r, "stage", CONTENT_LIMITS.shortText, "этап", fail);
  checkText(r, "description", CONTENT_LIMITS.description, "описание", fail);
  checkBoolean(r, "featured", fail);

  if (r.registrationType === undefined || r.registrationType === null) delete r.registrationType;
  else if (!REGISTRATION_TYPES.includes(/** @type {string} */ (r.registrationType)))
    fail("registrationType должен быть link или school");
  const bySchool = r.registrationType === "school";

  if (r.url === undefined || r.url === null) r.url = "";
  if (typeof r.url !== "string" || !isSafeUrl(r.url)) fail("Ссылка должна начинаться с https://");
  if (r.image !== undefined && !isSafeUrl(r.image))
    fail("Изображение: ссылка https:// или загруженный файл");
  if (r.source !== undefined) {
    if (typeof r.source !== "string" || !r.source || !isSafeUrl(r.source, { allowLocal: false }))
      fail("source: ссылка на официальный источник должна начинаться с https://");
  }
  if (r.verifiedAt !== undefined && !isCalendarDate(r.verifiedAt))
    fail("verifiedAt: дата проверки в формате ГГГГ-ММ-ДД");

  if (r.price !== undefined && r.price !== null) {
    const price = Number(r.price);
    if (typeof r.price === "boolean" || !Number.isFinite(price) || price < 0)
      fail("Стоимость не может быть отрицательной");
    if (price > CONTENT_LIMITS.price) fail("Стоимость слишком большая");
    r.price = price;
  }

  r.date = normalizeEventDate(r.date);
  if (!(r.date === "expected" || isCalendarDate(r.date)))
    fail("Дата проведения: ГГГГ-ММ-ДД, «ожидается» или «expected»");

  if (r.deadline === undefined || r.deadline === null || r.deadline === "") {
    if (!bySchool) fail("Укажите дедлайн регистрации или «ожидается»");
    delete r.deadline;
  } else {
    r.deadline = normalizeEventDate(r.deadline);
    if (!(r.deadline === "expected" || isCalendarDate(r.deadline)))
      fail("Дедлайн регистрации: ГГГГ-ММ-ДД, «ожидается» или «expected»");
  }

  if (r.registrationStart !== undefined && r.registrationStart !== "") {
    if (!isCalendarDate(r.registrationStart))
      fail("Начало регистрации: дата в формате ГГГГ-ММ-ДД");
  } else delete r.registrationStart;

  if (r.dateEnd !== undefined && r.dateEnd !== "") {
    if (!isCalendarDate(r.dateEnd)) fail("Дата окончания: дата в формате ГГГГ-ММ-ДД");
    if (!isCalendarDate(r.date)) fail("Дата окончания задаётся только вместе с точной датой начала");
    if (/** @type {string} */ (r.dateEnd) < /** @type {string} */ (r.date))
      fail("Дата окончания не может быть раньше даты проведения");
  } else delete r.dateEnd;

  // Registration may stay open during a participation window, so the deadline is compared with
  // the last day of the event.
  const deadline = isCalendarDate(r.deadline) ? /** @type {string} */ (r.deadline) : null;
  const lastDay = isCalendarDate(r.dateEnd)
    ? /** @type {string} */ (r.dateEnd)
    : isCalendarDate(r.date)
      ? /** @type {string} */ (r.date)
      : null;
  if (deadline && lastDay && deadline > lastDay)
    fail("Дедлайн регистрации не может быть позже окончания олимпиады");
  const start = typeof r.registrationStart === "string" ? r.registrationStart : null;
  if (start && deadline && start > deadline)
    fail("Начало регистрации не может быть позже дедлайна");
  if (start && lastDay && start > lastDay)
    fail("Начало регистрации не может быть позже окончания олимпиады");
}

// ---------------------------------------------------------------------------
// Cross-record rules
// ---------------------------------------------------------------------------

/**
 * IDs of records the given records point to (topics of lessons/tasks, tasks of mock tests).
 * @param {readonly ContentRecord[]} records
 * @returns {string[]}
 */
export function linkedRecordIds(records) {
  const ids = new Set();
  for (const record of records) {
    if (record.kind === "lessons" || record.kind === "tasks") ids.add(record.topicId);
    if (record.kind === "mock-tests") for (const id of record.taskIds) ids.add(id);
  }
  return [...ids];
}

/**
 * Checks references between records and fills `grade`/`subject` of lessons and tasks from their
 * topic. `known` must contain every linked record that is not part of `records` itself.
 * Mutates and returns `records`.
 *
 * @template {ContentRecord} T
 * @param {T[]} records
 * @param {ReadonlyMap<string, ContentRecord>} known
 * @returns {T[]}
 */
export function validateLinks(records, known) {
  /** @type {Map<string, ContentRecord>} */
  const byId = new Map(known);
  for (const record of records) byId.set(record.id, record);
  /**
   * @param {ContentRecord} record
   * @param {string} message
   * @returns {never}
   */
  const fail = (record, message) => {
    throw new ContentValidationError(`${record.id}: ${message}`, { recordId: record.id });
  };

  // Lessons and tasks first: mock tests compare against the inherited grade/subject of tasks.
  for (const record of records) {
    if (record.kind !== "lessons" && record.kind !== "tasks") continue;
    const topic = byId.get(record.topicId);
    if (!topic || topic.kind !== "topics")
      fail(record, `тема ${record.topicId || "не указана"} не найдена`);
    record.grade ??= topic.grade;
    record.subject ??= topic.subject;
    if (record.grade !== topic.grade || record.subject !== topic.subject)
      fail(record, `«${record.title}» относится к другому классу или предмету, чем тема`);
  }
  for (const record of records) {
    if (record.kind !== "mock-tests") continue;
    for (const taskId of record.taskIds) {
      const task = byId.get(taskId);
      if (!task || task.kind !== "tasks") fail(record, `задание ${taskId} не найдено`);
      if (task.grade !== record.grade || task.subject !== record.subject)
        fail(record, `задание ${taskId} относится к другому классу или предмету`);
    }
  }
  return records;
}
