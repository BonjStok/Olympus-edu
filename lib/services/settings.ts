import type { UserSettings } from "@/lib/domain/types";
import { regions } from "@/lib/content/regions.mjs";
import { GRADES, SUBJECTS } from "@/lib/content/validate.mjs";
import { unprocessable } from "@/lib/server/errors";
import { isPlainObject } from "@/lib/server/validate";
import type { ServiceContext } from "./context";
import { getProgress, progressKey, saveProgress } from "./progress";

export type SettingsUpdate = { [K in keyof UserSettings]?: UserSettings[K] | null };

/**
 * Validates a partial settings update: omitted fields are kept, `null` clears a field.
 * `region` is "" (whole country) or an exact name from lib/regions.ts.
 */
export function parseSettingsUpdate(input: unknown): SettingsUpdate {
  if (!isPlainObject(input))
    throw unprocessable("Настройки должны быть объектом", "INVALID_SETTINGS");
  const update: SettingsUpdate = {};
  if ("region" in input && input.region !== undefined) {
    const region = input.region;
    if (
      region !== null &&
      (typeof region !== "string" || (region !== "" && !regions.includes(region)))
    )
      throw unprocessable("Выберите регион из списка", "INVALID_SETTINGS");
    update.region = region;
  }
  if ("grade" in input && input.grade !== undefined) {
    const grade = input.grade;
    if (grade !== null && !(typeof grade === "number" && GRADES.includes(grade)))
      throw unprocessable("Класс должен быть 4, 5 или 6", "INVALID_SETTINGS");
    update.grade = grade as UserSettings["grade"] | null;
  }
  if ("subject" in input && input.subject !== undefined) {
    const subject = input.subject;
    if (subject !== null && !(typeof subject === "string" && SUBJECTS.includes(subject)))
      throw unprocessable("Предмет должен быть math или info", "INVALID_SETTINGS");
    update.subject = subject as UserSettings["subject"] | null;
  }
  return update;
}

export function applySettings(current: UserSettings | null, update: SettingsUpdate): UserSettings {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const settings: UserSettings = {};
  if (typeof next.region === "string") settings.region = next.region;
  if (typeof next.grade === "number") settings.grade = next.grade as UserSettings["grade"];
  if (typeof next.subject === "string") settings.subject = next.subject as UserSettings["subject"];
  return settings;
}

export async function saveSettings(ctx: ServiceContext, input: unknown): Promise<UserSettings> {
  const update = parseSettingsUpdate(input);
  const current = await getProgress<UserSettings>(ctx.db, ctx.actor.userId, progressKey.settings);
  const settings = applySettings(current, update);
  await saveProgress(ctx.db, ctx.actor.userId, progressKey.settings, settings, ctx.now);
  return settings;
}
