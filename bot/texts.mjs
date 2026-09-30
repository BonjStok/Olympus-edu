// @ts-check
/**
 * Every text the bot shows to a user lives in this module, so wording can be
 * edited in one place. Rules for texts:
 * - Russian, short and warm; written for a child of grades 4–6 and their parent;
 * - at most one emoji per message;
 * - MAX markdown only (`**bold**`, `*italic*`); dynamic values go through `md()`;
 * - a message never exceeds MAX_TEXT_LENGTH characters.
 */

import { isIsoDate, moscowToday } from "./time.mjs";

/** `NewMessageBody.text` limit from the Bot API schema. */
export const MAX_TEXT_LENGTH = 4000;

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/**
 * Russian plural form: plural(1, ["задача", "задачи", "задач"]) → "задача".
 * @param {number} n
 * @param {readonly [string, string, string]} forms one / few / many
 */
export function plural(n, forms) {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/**
 * "5 задач", "1 звезда".
 * @param {number} n
 * @param {readonly [string, string, string]} forms
 */
export function count(n, forms) {
  return `${n} ${plural(n, forms)}`;
}

export const WORDS = {
  task: /** @type {const} */ (["задача", "задачи", "задач"]),
  taskAcc: /** @type {const} */ (["задачу", "задачи", "задач"]),
  day: /** @type {const} */ (["день", "дня", "дней"]),
  point: /** @type {const} */ (["балл", "балла", "баллов"]),
  olympiad: /** @type {const} */ (["олимпиада", "олимпиады", "олимпиад"]),
  region: /** @type {const} */ (["регионе", "регионах", "регионах"]),
};

/**
 * «14 октября»; the year is added only when it differs from the current one.
 * @param {string} iso `YYYY-MM-DD`
 * @param {string} [today] `YYYY-MM-DD`
 */
export function formatDate(iso, today) {
  if (!isIsoDate(iso)) return "дата уточняется";
  const [year, month, day] = iso.split("-").map(Number);
  const label = `${day} ${MONTHS_GENITIVE[month - 1]}`;
  return today && today.slice(0, 4) !== String(year) ? `${label} ${year}` : label;
}

/**
 * «14 октября», «14–16 октября», «30 октября – 2 ноября».
 * @param {string} start
 * @param {string | undefined} end
 * @param {string} [today]
 */
export function formatDateRange(start, end, today) {
  if (!end || end === start || !isIsoDate(end) || !isIsoDate(start) || end < start)
    return formatDate(start, today);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  if (sameYear && start.slice(0, 7) === end.slice(0, 7)) {
    return `${Number(start.slice(8))}–${formatDate(end, today)}`;
  }
  return `${formatDate(start, sameYear ? end.slice(0, 4) + "-01-01" : today)} – ${formatDate(end, today)}`;
}

/**
 * Collapses whitespace and trims; limits the length with an ellipsis.
 * @param {unknown} value
 * @param {number} [max]
 */
export function oneLine(value, max = 200) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

/**
 * Makes an untrusted value safe to embed into a MAX markdown message:
 * one line, and characters that can open markup are backslash-escaped
 * (CommonMark escapes; MAX declares CommonMark-based parsing).
 * @param {unknown} value
 * @param {number} [max]
 */
export function md(value, max = 200) {
  return oneLine(value, max)
    .replace(/[\\*_`[\]]/g, "\\$&")
    .replace(/~~|\+\+|\^\^/g, (pair) => `\\${pair[0]}\\${pair[1]}`);
}

/**
 * Guarantees the API text limit (defensive; normal screens are far shorter).
 * @param {string} text
 */
export function clampText(text) {
  return text.length <= MAX_TEXT_LENGTH ? text : text.slice(0, MAX_TEXT_LENGTH - 1) + "…";
}

const SUBJECTS = { math: "математика", info: "информатика" };

/**
 * @param {{ subject?: string, subjects?: string[] }} o
 */
export function subjectLabel(o) {
  const list = Array.isArray(o.subjects) && o.subjects.length ? o.subjects : [o.subject];
  const names = [...new Set(list)]
    .map((s) => SUBJECTS[/** @type {keyof typeof SUBJECTS} */ (s)])
    .filter(Boolean);
  return names.join(" и ");
}

// ---------------------------------------------------------------------------
// Buttons (≤ 128 characters, see keyboard.mjs)
// ---------------------------------------------------------------------------

export const BUTTONS = {
  openApp: "Открыть Олимпус",
  calendar: "Ближайшие олимпиады",
  progress: "Мой прогресс",
  how: "Как это работает",
  menu: "Меню",
  fullCalendar: "Весь календарь",
  training: "Решать задачи",
  myOlympiads: "Мои олимпиады",
  reminders: "Напоминания",
  remindersOn: "Включить напоминания",
  remindersOff: "Выключить напоминания",
  remindersStop: "Не напоминать",
  openEvent: "Об олимпиаде",
  openMock: "Пробный тур",
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * First message after «Начать» (bot_started) and /start.
 * @param {{ firstName?: string | null }} p
 */
export function greetingText({ firstName }) {
  const name = md(firstName ?? "", 64);
  return [
    name ? `Привет, ${name}! 👋` : "Привет! 👋",
    "",
    "Я чат-бот **«Олимпуса»**. Помогаю ребятам 4–6 классов готовиться к олимпиадам по математике и информатике.",
    "",
    "В приложении – календарь олимпиад, теория, тренировочные задачи и пробные туры на время. А здесь можно быстро узнать ближайшие олимпиады и свой прогресс.",
  ].join("\n");
}

export const MENU_TEXT = "**Меню «Олимпуса»**\n\nЧто показать?";

/**
 * @param {{ remindersAvailable: boolean }} p
 */
export function helpText({ remindersAvailable }) {
  return [
    "Вот что я умею:",
    "/calendar – ближайшие олимпиады",
    "/progress – твой прогресс и «Мои олимпиады»",
    remindersAvailable ? "/reminders – напоминания об олимпиадах" : "/reminders – про напоминания",
    "/help – эта подсказка",
    "",
    "Задачи, теория и пробные туры – в приложении «Олимпус».",
  ].join("\n");
}

export const UNKNOWN_TEXT =
  "Я пока понимаю только команды и кнопки. Выбери, что показать, или напиши /help.";

/**
 * @param {{ remindersAvailable: boolean }} p
 */
export function howItWorksText({ remindersAvailable }) {
  const steps = [
    "Открой «Олимпус» и укажи класс и регион – так подборка олимпиад станет точнее.",
    "В календаре отметь олимпиады, в которых участвуешь, – они появятся в «Моих олимпиадах».",
    "Изучай теорию, решай задачи и проходи пробные туры на время. За пройденные блоки – звёзды, за решённые задачи – медали.",
    "Здесь, в чате, смотри ближайшие олимпиады и свой прогресс: /calendar и /progress.",
  ];
  if (remindersAvailable)
    steps.push("Включи /reminders – и я напомню об олимпиаде за 3 дня и накануне.");
  return [
    "**Как это работает**",
    "",
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "Для родителей: бот не спрашивает телефон и не присылает рекламу – он показывает только данные из «Олимпуса».",
  ].join("\n");
}

export const ERROR_TEXT =
  "Не получилось загрузить данные. Попробуй ещё раз чуть позже – или открой приложение.";

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CalendarLine
 * @property {string} title
 * @property {string} date `YYYY-MM-DD`
 * @property {string} [dateEnd]
 * @property {string} [subject]
 * @property {string[]} [subjects]
 * @property {string} region "" for all-Russia events
 * @property {string} [format]
 * @property {string} [deadline]
 * @property {string} [registrationType]
 * @property {boolean} [demo]
 * @property {number} editions > 1 when regional editions of a series were collapsed
 */

/**
 * @param {{ grade?: number, region?: string }} scope
 */
function calendarScope({ grade, region }) {
  const who = grade ? `${grade} класс` : "";
  const where = region ? `${md(region, 80)} и вся Россия` : "вся Россия";
  return [who, where].filter(Boolean).join(" · ");
}

/**
 * @param {CalendarLine} item
 * @param {string} today
 */
function registrationLine(item, today) {
  if (item.registrationType === "school") return "Участников регистрирует школа";
  if (!item.deadline || !isIsoDate(item.deadline)) return "Сроки регистрации уточняются";
  if (item.deadline < today) return "Регистрация завершена";
  return `Регистрация до ${formatDate(item.deadline, today)}`;
}

/**
 * @param {{ items: CalendarLine[], today: string, grade?: number, region?: string }} p
 */
export function calendarText({ items, today, grade, region }) {
  const lines = ["**Ближайшие олимпиады**", calendarScope({ grade, region }), ""];
  if (!items.length) {
    lines.push(
      "Ближайших олимпиад с известной датой пока нет. В календаре приложения есть олимпиады, даты которых организаторы ещё объявят.",
    );
  }
  items.forEach((item, i) => {
    const demo = item.demo ? " (учебный пример)" : "";
    const format = item.format === "offline" ? "очно" : "онлайн";
    const details =
      item.editions > 1
        ? `от ${formatDate(item.date, today)} · ${subjectLabel(item)} · в ${count(item.editions, WORDS.region)}, даты зависят от региона`
        : `${formatDateRange(item.date, item.dateEnd, today)} · ${subjectLabel(item)} · ${format}, ${item.region ? md(item.region, 80) : "вся Россия"}`;
    lines.push(`${i + 1}. **${md(item.title, 120)}**${demo}`);
    lines.push(details);
    lines.push(registrationLine(item, today));
    lines.push("");
  });
  if (items.length) lines.push("Нажми на олимпиаду, чтобы открыть подробности в приложении.");
  if (!grade || !region)
    lines.push(
      "Укажи класс и регион в профиле «Олимпуса» – и я подберу олимпиады точнее, с региональными этапами.",
    );
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProgressView
 * @property {number} stars
 * @property {{ math: number, info: number, total: number }} solved
 * @property {{ earned: number, total: number, next?: { name: string, subject: string, remaining: number } }} medals
 * @property {{ title: string, score: number, max: number, finishedAt?: number } | undefined} lastMock
 * @property {{ title: string, date: string, dateEnd?: string }[]} upcoming registrations with a known date
 * @property {{ title: string }[]} expected registrations whose date is not announced yet
 */

/**
 * @param {number} ms
 * @param {string} today
 */
function dateFromMs(ms, today) {
  return formatDate(moscowToday(ms), today);
}

/**
 * @param {ProgressView & { today: string }} p
 */
export function progressText(p) {
  const lines = ["**Твой прогресс**", ""];
  lines.push(`Звёзды за пройденные блоки: ${p.stars}`);
  const bySubject =
    p.solved.math && p.solved.info
      ? ` (математика – ${p.solved.math}, информатика – ${p.solved.info})`
      : "";
  lines.push(`Решено задач: ${p.solved.total}${bySubject}`);
  lines.push(`Медали: ${p.medals.earned} из ${p.medals.total}`);
  if (p.medals.next) {
    const { name, subject, remaining } = p.medals.next;
    lines.push(
      `До медали «${name}» (${SUBJECTS[/** @type {keyof typeof SUBJECTS} */ (subject)] ?? subject}) – ещё ${count(remaining, WORDS.taskAcc)}.`,
    );
  }
  if (p.lastMock) {
    const when = p.lastMock.finishedAt ? `, ${dateFromMs(p.lastMock.finishedAt, p.today)}` : "";
    lines.push(
      `Последний пробный тур: «${md(p.lastMock.title, 100)}» – ${p.lastMock.score} из ${count(p.lastMock.max, WORDS.point)}${when}.`,
    );
  }
  lines.push("", "**Мои олимпиады**");
  if (!p.upcoming.length && !p.expected.length) {
    lines.push("Пока пусто. Отметь олимпиады в календаре приложения – и они появятся здесь.");
  }
  for (const o of p.upcoming)
    lines.push(`• ${formatDateRange(o.date, o.dateEnd, p.today)} – ${md(o.title, 120)}`);
  for (const o of p.expected) lines.push(`• дата уточняется – ${md(o.title, 120)}`);
  return lines.join("\n");
}

export const NO_PROGRESS_TEXT = [
  "**Твой прогресс**",
  "",
  "Пока здесь пусто. Открой «Олимпус» кнопкой ниже, реши первую задачу или отметь олимпиаду – и я покажу звёзды, медали и твои олимпиады.",
  "",
  "Важно: открывай приложение через этого бота, тогда прогресс сохранится в твоём профиле MAX.",
].join("\n");

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export const REMINDERS_UNAVAILABLE_TEXT = [
  "**Напоминания**",
  "",
  "Напоминания в чате пока не включены. Следить за датами можно в разделе «Мои олимпиады» в приложении – там видно, сколько дней осталось.",
].join("\n");

/**
 * @param {{ enabled: boolean, registrations: number }} p
 */
export function remindersText({ enabled, registrations }) {
  const lines = enabled
    ? [
        "**Напоминания включены**",
        "",
        "Я напишу за 3 дня и накануне каждой олимпиады из «Моих олимпиад» – с 10:00 до 20:00 по Москве. Только о твоих олимпиадах, без рекламы.",
      ]
    : [
        "**Напоминания об олимпиадах**",
        "",
        "Могу напомнить за 3 дня и накануне каждой олимпиады из «Моих олимпиад». Пишу только с 10:00 до 20:00 по Москве и только о твоих олимпиадах.",
        "",
        "Напоминания выключены. Включить?",
      ];
  if (!registrations)
    lines.push("", "Сейчас в «Моих олимпиадах» пусто – отметь олимпиады в календаре приложения.");
  return lines.join("\n");
}

export const REMINDERS_ON_NOTICE = "Напоминания включены";
export const REMINDERS_OFF_NOTICE = "Напоминания выключены";
export const FAILURE_NOTICE = "Не получилось. Попробуй ещё раз чуть позже";

/**
 * Reminder push (only when BOT_REMINDERS=on and the user opted in).
 * @param {{ kind: "d3" | "d1", title: string, date: string, today: string, hasMock: boolean }} p
 */
export function reminderText({ kind, title, date, today, hasMock }) {
  const when = formatDate(date, today);
  const name = md(title, 150);
  const lines =
    kind === "d3"
      ? [
          `📅 Через 3 дня, **${when}**, – **«${name}»**.`,
          hasMock
            ? "Пройди пробный тур, чтобы потренироваться в темпе олимпиады."
            : "Загляни в приложение: там подробности и ссылка на олимпиаду.",
        ]
      : [
          `🍀 Завтра, **${when}**, – **«${name}»**.`,
          "Проверь время начала и ссылку, приготовь ручку и черновик. Удачи!",
        ];
  lines.push("", "Напоминания можно выключить в /reminders.");
  return lines.join("\n");
}
