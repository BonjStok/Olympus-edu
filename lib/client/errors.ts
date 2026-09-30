/**
 * Error dictionary of the mini-app.
 *
 * The server answers every failure with `{ error, code }`, where `error` is a human Russian
 * text. The client keeps that text, except for the codes where the UI has to offer something
 * specific – repeat the request, reopen the app, sign in again as a teacher, go back to the
 * list – or where the server's wording is too technical for a child. Older servers send no
 * code, so a few known texts are recognised as well.
 */

/**
 * What the UI should offer next to the message:
 * - `retry` – «Попробовать ещё раз» (the server or the network is down for a moment);
 * - `reopen` – close and open the mini-app again (the session or MAX launch data is broken);
 * - `login` – the teacher has to sign in again;
 * - `back` – the record is gone: lead back to the list instead of retrying;
 * - `none` – the message is enough (a mistake in the input, a rule of the app).
 */
export type ErrorAction = "retry" | "reopen" | "login" | "back" | "none";

export interface FriendlyError {
  /** Replacement text; `undefined` keeps the server's own text. */
  message?: string;
  action: ErrorAction;
}

export const RUNNER_DOWN =
  "Проверка программ сейчас не работает. Твой код сохранён – попробуй позже, а пока можно решать задачи с ответом-числом";

const REOPEN = "Сеанс закончился. Закрой Олимпус и открой снова – прогресс сохранён";
const SERVER_DOWN =
  "Сервер Олимпуса ненадолго недоступен. Попробуй ещё раз через минуту – прогресс не потеряется";

/** Codes whose text is written by the client. */
const BY_CODE: Record<string, FriendlyError> = {
  NETWORK: {
    message: "Нет связи с сервером. Проверь интернет и нажми «Попробовать ещё раз»",
    action: "retry",
  },
  OFFLINE: {
    message: "Похоже, пропал интернет. Подключись к сети и нажми «Попробовать ещё раз»",
    action: "retry",
  },
  TIMEOUT: { message: "Сервер долго не отвечает. Попробуй ещё раз через минуту", action: "retry" },
  UNAUTHORIZED: { message: REOPEN, action: "reopen" },
  SESSION_EXPIRED: { message: REOPEN, action: "reopen" },
  BAD_ORIGIN: {
    message: "Олимпус открыт по необычной ссылке. Закрой его и открой снова из MAX",
    action: "reopen",
  },
  MAX_AUTH_FAILED: {
    message:
      "Не получилось войти через MAX – пока занимаемся как гость. Чтобы войти, закрой Олимпус и открой снова",
    action: "reopen",
  },
  MAX_NOT_CONFIGURED: {
    message:
      "Вход через MAX пока не настроен – занимаемся как гость, прогресс сохранится на этом устройстве",
    action: "none",
  },
  ADMIN_REQUIRED: { message: "Нужно снова войти как учитель", action: "login" },
  ADMIN_EXPIRED: {
    message: "Режим учителя закрылся после перерыва. Войдите снова – форма останется заполненной",
    action: "login",
  },
  WRONG_PASSWORD: {
    message: "Пароль не подошёл. Проверьте раскладку клавиатуры и попробуйте ещё раз",
    action: "none",
  },
  RUNNER_UNAVAILABLE: { message: RUNNER_DOWN, action: "retry" },
  SERVER_ERROR: {
    message: "На сервере что-то пошло не так. Попробуй ещё раз через минуту",
    action: "retry",
  },
};

/** «через 40 секунд», «через 3 минуты». */
export function waitText(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return `через ${s} ${plural(s, "секунду", "секунды", "секунд")}`;
  }
  const m = Math.ceil(seconds / 60);
  return `через ${m} ${plural(m, "минуту", "минуты", "минут")}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Codes that depend on `Retry-After`. */
function limited(code: string, retryAfter?: number): FriendlyError | null {
  const wait = retryAfter && retryAfter > 0 ? waitText(retryAfter) : "";
  if (code === "RATE_LIMITED")
    return {
      message: `Слишком много попыток подряд. Попробуйте снова ${wait || "через несколько минут"}`,
      action: "none",
    };
  if (code === "RUNNER_BUSY")
    return {
      message: `Проверка программ сейчас занята. Попробуй ещё раз ${wait || "через несколько секунд"}`,
      action: "retry",
    };
  return null;
}

/** Codes whose server text is kept, with the action the UI should offer. */
function actionOf(code: string): ErrorAction | null {
  if (code === "NOT_FOUND" || code.endsWith("_NOT_FOUND")) return "back";
  if (code.startsWith("DATABASE_")) return "retry";
  if (code === "STORAGE_UNAVAILABLE") return "retry";
  return null;
}

/** Texts of servers that send no `code`. */
const BY_TEXT: [RegExp, FriendlyError][] = [
  [/judge0|runner_url|сервер выполнения|раннер/i, BY_CODE.RUNNER_UNAVAILABLE],
  [/вход max пока не подключ|токен бота/i, BY_CODE.MAX_NOT_CONFIGURED],
  [/подпись max|данные max устарели|initdata/i, BY_CODE.MAX_AUTH_FAILED],
  [/обновите страницу для начала сеанса/i, BY_CODE.UNAUTHORIZED],
  [/введите число/i, { message: "Нужно число, например 12 или 0,5", action: "none" }],
  [/требуется вход администратора/i, BY_CODE.ADMIN_REQUIRED],
  [/неверный пароль/i, BY_CODE.WRONG_PASSWORD],
  [/слишком много попыток/i, { action: "none" }],
  [
    /попытка не найдена/i,
    { message: "Эту попытку не нашли. Начни пробник заново", action: "back" },
  ],
];

/**
 * Child-friendly text and next step for a failed request, or `null` when the server's text
 * (or the status default) should be shown as is.
 */
export function friendlyError(
  status: number,
  code: string | undefined,
  message: string | undefined,
  retryAfter?: number,
): FriendlyError | null {
  if (code) {
    if (BY_CODE[code]) return BY_CODE[code];
    const byLimit = limited(code, retryAfter);
    if (byLimit) return byLimit;
    if (code.startsWith("DATABASE_")) return { message: SERVER_DOWN, action: "retry" };
    const action = actionOf(code);
    if (action) return { action };
  }
  const text = message ?? "";
  for (const [re, value] of BY_TEXT) if (re.test(text)) return value;
  if (status === 0) return BY_CODE.NETWORK;
  if (status === 429) return limited("RATE_LIMITED", retryAfter);
  return null;
}
