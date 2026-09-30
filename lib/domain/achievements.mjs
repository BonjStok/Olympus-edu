// @ts-check
/**
 * Achievement rules shared by the mini-app (lib/ui/progress.ts), the server and the chat-bot
 * (bot/progress.mjs). Plain ESM with JSDoc so the bot can import it at runtime without a build.
 */

/**
 * Medals per subject, earned once the child has solved at least `threshold` tasks on their own.
 * @type {ReadonlyArray<Readonly<{ threshold: number, name: string }>>}
 */
export const MEDALS = Object.freeze([
  Object.freeze({ threshold: 1, name: "Первый шаг" }),
  Object.freeze({ threshold: 5, name: "Исследователь" }),
  Object.freeze({ threshold: 15, name: "Мыслитель" }),
  Object.freeze({ threshold: 30, name: "Мастер" }),
  Object.freeze({ threshold: 60, name: "Олимпиец" }),
]);

/** Tasks of one topic a child must solve on their own to get the practice star. */
export const PRACTICE_STAR_GOAL = 3;

/**
 * Whether a `task:<id>` progress value counts for stars and medals: solved correctly and not
 * only after opening the solution.
 * @param {unknown} progress
 * @returns {boolean}
 */
export function countsAsSolved(progress) {
  if (!progress || typeof progress !== "object") return false;
  const task = /** @type {{ correct?: unknown, solvedAfterReveal?: unknown }} */ (progress);
  return task.correct === true && task.solvedAfterReveal !== true;
}
