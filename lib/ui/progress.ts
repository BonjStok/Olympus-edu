/** Pure selectors over the progress map: stars, medals, solved tasks, mock attempts. */
import { serverNow } from "@/lib/client/clock";
import { countsAsSolved as countsAsSolvedRule, MEDALS } from "@/lib/domain/achievements.mjs";
import type {
  MockAttempt,
  MockTest,
  ProgressMap,
  StarProgress,
  Subject,
  TaskProgress,
  UserSettings,
} from "@/lib/domain/types";

// Medal thresholds, the practice-star goal and the "solved on one's own" rule are shared with
// the server and the chat-bot. Theory star needs every lesson of the topic read.
export { MEDALS, PRACTICE_STAR_GOAL } from "@/lib/domain/achievements.mjs";

export function isStarKey(key: string): boolean {
  return (
    key.startsWith("theory-star:") || key.startsWith("practice-star:") || key.startsWith("star:")
  );
}

export function hasTheoryStar(p: ProgressMap, topicId: string): boolean {
  return !!(p[`theory-star:${topicId}`] || p[`star:${topicId}`]);
}

export function hasPracticeStar(p: ProgressMap, topicId: string): boolean {
  return !!p[`practice-star:${topicId}`];
}

export interface EarnedStar extends StarProgress {
  key: string;
  topicId: string;
}

export function earnedStars(p: ProgressMap): EarnedStar[] {
  return Object.entries(p)
    .filter(([key]) => isStarKey(key))
    .map(([key, value]) => {
      const v = (value ?? {}) as Partial<StarProgress>;
      return {
        key,
        topicId: key.slice(key.indexOf(":") + 1),
        title: v.title ?? "Тема",
        subject: v.subject === "info" ? "info" : "math",
        type: key.startsWith("practice-star:") ? "practice" : "theory",
        date: typeof v.date === "number" ? v.date : 0,
      } satisfies EarnedStar;
    })
    .sort((a, b) => b.date - a.date);
}

export function starCount(p: ProgressMap): number {
  return Object.keys(p).filter(isStarKey).length;
}

export function taskProgress(p: ProgressMap, taskId: string): TaskProgress | undefined {
  const v = p[`task:${taskId}`];
  return v && typeof v === "object" ? (v as TaskProgress) : undefined;
}

export function isLessonRead(p: ProgressMap, lessonId: string): boolean {
  return !!p[`lesson:${lessonId}`];
}

/** Solved on one's own: tasks solved only after opening the solution do not count. */
export function countsAsSolved(t: TaskProgress | undefined): boolean {
  return countsAsSolvedRule(t);
}

export type TaskState = "solved" | "solved-after-reveal" | "wrong" | "new";

export function taskState(p: ProgressMap, taskId: string): TaskState {
  const t = taskProgress(p, taskId);
  if (!t) return "new";
  if (t.correct) return t.solvedAfterReveal ? "solved-after-reveal" : "solved";
  return "wrong";
}

export function solvedCount(p: ProgressMap, subject?: Subject): number {
  return Object.entries(p).filter(([key, v]) => {
    if (!key.startsWith("task:") || !v || typeof v !== "object") return false;
    const t = v as TaskProgress;
    return countsAsSolved(t) && (!subject || t.subject === subject);
  }).length;
}

export interface MedalState {
  name: string;
  threshold: number;
  earned: boolean;
}

export function medalStates(solved: number): MedalState[] {
  return MEDALS.map((m) => ({ ...m, earned: solved >= m.threshold }));
}

export function medalCount(p: ProgressMap): number {
  return (["math", "info"] as const).reduce(
    (n, s) => n + medalStates(solvedCount(p, s)).filter((m) => m.earned).length,
    0,
  );
}

/** The next medal to earn and how many tasks are left, or null when all are earned. */
export function nextMedal(solved: number): { name: string; left: number } | null {
  const next = MEDALS.find((m) => solved < m.threshold);
  return next ? { name: next.name, left: next.threshold - solved } : null;
}

export function attemptsOf(p: ProgressMap): MockAttempt[] {
  return Object.entries(p)
    .filter(([key, v]) => key.startsWith("attempt:") && v && typeof v === "object")
    .map(([, v]) => v as MockAttempt)
    .sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
}

export function attemptsForTest(p: ProgressMap, testId: string): MockAttempt[] {
  return attemptsOf(p).filter((a) => a.testId === testId);
}

/** An unfinished attempt whose time has not run out yet. */
export function activeAttempt(
  p: ProgressMap,
  testId: string,
  now = serverNow(),
): MockAttempt | undefined {
  return attemptsForTest(p, testId).find((a) => !a.finished && a.ends > now);
}

/** Unfinished attempt that is still running anywhere – used to warn about hints during a mock. */
export function runningAttempt(p: ProgressMap, now = serverNow()): MockAttempt | undefined {
  return attemptsOf(p).find((a) => !a.finished && a.ends > now);
}

export function bestResult(attempts: MockAttempt[]): { score: number; max: number } | null {
  let best: { score: number; max: number } | null = null;
  for (const a of attempts) {
    if (!a.finished || typeof a.score !== "number" || typeof a.max !== "number") continue;
    if (!best || a.score / (a.max || 1) > best.score / (best.max || 1))
      best = { score: a.score, max: a.max };
  }
  return best;
}

export function mockTaskCount(m: Pick<MockTest, "randomize" | "taskCount" | "taskIds">): number {
  const total = m.taskIds?.length ?? 0;
  if (m.randomize && m.taskCount) return Math.min(m.taskCount, total || m.taskCount);
  return total;
}

export function percent(score: number, max: number): number {
  return max > 0 ? Math.round((score / max) * 100) : 0;
}

export function readSettings(p: ProgressMap): UserSettings {
  const v = p.settings;
  return v && typeof v === "object" ? (v as UserSettings) : {};
}
