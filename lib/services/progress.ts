import { countsAsSolved } from "@/lib/domain/achievements.mjs";
import type { ProgressMap } from "@/lib/domain/types";
import { parseJson, type Db } from "@/lib/server/db";
import { isAttempt, presentAttempt } from "./attempts";

export { sanitizeAttempt } from "./attempts";

/** Progress keys (table `progress`, see lib/domain/types.ts). */
export const progressKey = {
  lesson: (lessonId: string) => `lesson:${lessonId}`,
  task: (taskId: string) => `task:${taskId}`,
  code: (taskId: string) => `code:${taskId}`,
  registration: (olympiadId: string) => `registration:${olympiadId}`,
  theoryStar: (topicId: string) => `theory-star:${topicId}`,
  legacyStar: (topicId: string) => `star:${topicId}`,
  practiceStar: (topicId: string) => `practice-star:${topicId}`,
  attempt: (attemptId: string) => `attempt:${attemptId}`,
  settings: "settings",
} as const;

interface ProgressRow {
  key: string;
  data: string;
  updated: number;
}

export async function getProgress<T>(db: Db, userId: string, key: string): Promise<T | null> {
  const row = await db.one<Pick<ProgressRow, "data">>(
    "SELECT data FROM progress WHERE user_id = $1 AND key = $2",
    [userId, key],
  );
  return parseJson<T>(row?.data);
}

/**
 * Upserts one progress value. Every reader expects a JSON value, so an empty one (`undefined`
 * would become SQL NULL and violate `progress.data NOT NULL`, `null` would be stored as the text
 * "null") is a programming error: remove a key with `deleteProgress` instead.
 */
export async function saveProgress(
  db: Db,
  userId: string,
  key: string,
  value: unknown,
  now: number,
): Promise<void> {
  const data = value === null ? undefined : JSON.stringify(value);
  if (data === undefined) throw new Error(`Refusing to store an empty progress value for ${key}`);
  await db.execute(
    `INSERT INTO progress(user_id, key, data, updated) VALUES($1, $2, $3, $4)
     ON CONFLICT(user_id, key) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
    [userId, key, data, now],
  );
}

export async function deleteProgress(db: Db, userId: string, key: string): Promise<void> {
  await db.execute("DELETE FROM progress WHERE user_id = $1 AND key = $2", [userId, key]);
}

export async function resetProgress(db: Db, userId: string): Promise<number> {
  return db.execute("DELETE FROM progress WHERE user_id = $1", [userId]);
}

export interface ProgressEntry {
  key: string;
  value: unknown;
  updated: number;
}

/** All progress of a user, oldest first, with mock attempts sanitised for the client. */
export async function listProgress(db: Db, userId: string): Promise<ProgressEntry[]> {
  const rows = await db.query<ProgressRow>(
    "SELECT key, data, updated FROM progress WHERE user_id = $1 ORDER BY updated, key",
    [userId],
  );
  return rows.map((row) => ({
    key: row.key,
    value: sanitizeProgressValue(row.key, parseJson<unknown>(row.data)),
    updated: Number(row.updated),
  }));
}

export function progressMap(entries: readonly ProgressEntry[]): ProgressMap {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

export function sanitizeProgressValue(key: string, value: unknown): unknown {
  return key.startsWith("attempt:") && isAttempt(value) ? presentAttempt(value) : value;
}

// ---------------------------------------------------------------------------
// Guest -> MAX merge
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/**
 * Task progress merge. A clean solve on either side (`countsAsSolved`, shared with the mini-app and
 * the chat-bot) wins: then the merged task is neither `revealed` nor `solvedAfterReveal`.
 */
function mergeTaskProgress(a: Json, b: Json, newer: Json, older: Json): Json {
  const correct = Boolean(a.correct || b.correct);
  const cleanSolve = countsAsSolved(a) || countsAsSolved(b);
  const merged: Json = {
    ...older,
    ...newer,
    correct,
    lastCorrect: Boolean(newer.lastCorrect),
    attempts: Math.max(Number(a.attempts) || 0, Number(b.attempts) || 0),
    selfChecked: Boolean(a.selfChecked || b.selfChecked),
  };
  delete merged.revealed;
  delete merged.solvedAfterReveal;
  if (!cleanSolve && (a.revealed || b.revealed)) merged.revealed = true;
  if (correct && !cleanSolve && (a.solvedAfterReveal || b.solvedAfterReveal))
    merged.solvedAfterReveal = true;
  return merged;
}

/**
 * Merges one progress value of a guest (`from`) into the MAX account (`to`). Achievements are never
 * lost: "solved", "read" and "registered" flags are OR-ed, attempts take the maximum, stars keep the
 * earliest date. Settings are merged field by field (newer wins); anything else (code drafts,
 * mock attempts) – the newer value wins.
 */
export function mergeProgressValue(
  key: string,
  from: unknown,
  to: unknown,
  fromUpdated: number,
  toUpdated: number,
): unknown {
  if (to === null || to === undefined) return from;
  if (from === null || from === undefined) return to;
  const fromNewer = fromUpdated >= toUpdated;
  const a = asObject(from);
  const b = asObject(to);
  const newer = fromNewer ? a : b;
  const older = fromNewer ? b : a;

  if (key.startsWith("task:")) return mergeTaskProgress(a, b, newer, older);
  if (key.startsWith("lesson:")) return { ...older, ...newer, read: Boolean(a.read || b.read) };
  if (key.startsWith("registration:"))
    return { ...older, ...newer, registered: Boolean(a.registered || b.registered) };
  if (/^(star|theory-star|practice-star):/.test(key)) {
    const dates = [Number(a.date) || 0, Number(b.date) || 0].filter(Boolean);
    return { ...older, ...newer, date: dates.length ? Math.min(...dates) : newer.date };
  }
  if (key === progressKey.settings) return { ...older, ...newer };
  return fromNewer ? from : to;
}

/**
 * Moves the progress of a guest into the verified MAX identity (one transaction) and removes the
 * guest's rows and sessions. Only `guest:*` → `max:*` merges are allowed.
 */
export async function mergeUserProgress(
  db: Db,
  fromUserId: string,
  toUserId: string,
  now: number,
): Promise<number> {
  if (!fromUserId.startsWith("guest:") || !toUserId.startsWith("max:")) return 0;
  return db.transaction(async (tx) => {
    const fromRows = await tx.query<ProgressRow>(
      "SELECT key, data, updated FROM progress WHERE user_id = $1 FOR UPDATE",
      [fromUserId],
    );
    const toRows = await tx.query<ProgressRow>(
      "SELECT key, data, updated FROM progress WHERE user_id = $1 FOR UPDATE",
      [toUserId],
    );
    const target = new Map(toRows.map((row) => [row.key, row]));
    for (const row of fromRows) {
      const current = target.get(row.key);
      const merged = mergeProgressValue(
        row.key,
        parseJson<unknown>(row.data),
        current ? parseJson<unknown>(current.data) : null,
        Number(row.updated) || 0,
        Number(current?.updated) || 0,
      );
      // Nothing to move (both sides empty): leave the account as it is.
      if (merged === null || merged === undefined) continue;
      const updated = Math.max(Number(row.updated) || 0, Number(current?.updated) || 0, now);
      await saveProgress(tx, toUserId, row.key, merged, updated);
    }
    await tx.execute("DELETE FROM progress WHERE user_id = $1", [fromUserId]);
    await tx.execute("DELETE FROM sessions WHERE user_id = $1", [fromUserId]);
    return fromRows.length;
  });
}
