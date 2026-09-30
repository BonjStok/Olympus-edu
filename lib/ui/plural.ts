/**
 * Russian plural forms: «1 задание / 2 задания / 5 заданий».
 */

export type PluralForms = readonly [one: string, few: string, many: string];

export const WORDS = {
  task: ["задание", "задания", "заданий"],
  /** After «из»: «из 1 задания», «из 2 заданий». */
  taskGen: ["задания", "заданий", "заданий"],
  problem: ["задача", "задачи", "задач"],
  /** «1 задача решена / 2 задачи решены / 5 задач решено». */
  solvedProblem: ["задача решена", "задачи решены", "задач решено"],
  /** «Реши ещё 1 задачу / 2 задачи / 5 задач». */
  problemAcc: ["задачу", "задачи", "задач"],
  point: ["балл", "балла", "баллов"],
  /** After «из»: «из 1 балла», «из 2 баллов», «из 10 баллов». */
  pointGen: ["балла", "баллов", "баллов"],
  lesson: ["урок", "урока", "уроков"],
  lessonGen: ["урока", "уроков", "уроков"],
  star: ["звезда", "звезды", "звёзд"],
  minute: ["минута", "минуты", "минут"],
  second: ["секунда", "секунды", "секунд"],
  medal: ["медаль", "медали", "медалей"],
  olympiad: ["олимпиада", "олимпиады", "олимпиад"],
  attempt: ["попытка", "попытки", "попыток"],
  region: ["регион", "региона", "регионов"],
  /** «в 1 регионе / в 2 регионах / в 86 регионах» */
  regionPrep: ["регионе", "регионах", "регионах"],
  topic: ["тема", "темы", "тем"],
  solution: ["решение", "решения", "решений"],
  day: ["день", "дня", "дней"],
  material: ["материал", "материала", "материалов"],
  answer: ["ответ", "ответа", "ответов"],
  test: ["тест", "теста", "тестов"],
  card: ["карточка", "карточки", "карточек"],
} as const satisfies Record<string, PluralForms>;

/** Picks the right form for a number. Fractions take the «few» form: «1,5 балла». */
export function pluralForm(n: number, forms: PluralForms): string {
  if (!Number.isFinite(n)) return forms[2];
  if (!Number.isInteger(n)) return forms[1];
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** «5 заданий». Numbers are formatted the Russian way: «1,5 балла». */
export function plural(n: number, forms: PluralForms): string {
  return `${formatNumber(n)} ${pluralForm(n, forms)}`;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(".", ",");
}
