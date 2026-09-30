/** Pure helpers for mock tests (пробники). */
import type {
  MockAnswer,
  MockAttempt,
  MockResult,
  MockTest,
  ReviewedTask,
  PublicTask,
} from "@/lib/domain/types";
import { SUBJECT_LABEL } from "./format";

export type ResultStatus = NonNullable<MockResult["status"]>;

const RUNNER_NOTE = /judge0|runner|сервер выполнения|не подключ|не настроен|недоступ/i;

/** Status of one reviewed task, also for attempts saved before `status` existed. */
export function resultStatus(
  r: MockResult | undefined,
  task: Pick<ReviewedTask, "type">,
): ResultStatus {
  if (r?.status) return r.status;
  if (!r) return task.type === "proof" ? "self-check" : "wrong";
  if (r.correct) return "correct";
  if (task.type === "proof" && r.note !== "Самопроверка") return "self-check";
  if (task.type === "code" && r.note && RUNNER_NOTE.test(r.note)) return "unchecked";
  return "wrong";
}

export function pendingCount(a: MockAttempt<ReviewedTask>): number {
  if (typeof a.pending === "number") return a.pending;
  return a.tasks.filter(
    (t) =>
      resultStatus(
        a.results?.find((r) => r.id === t.id),
        t,
      ) === "unchecked",
  ).length;
}

export function isAnswered(value: MockAnswer | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return value.code.trim() !== "";
}

export function answeredCount(a: Pick<MockAttempt, "tasks" | "answers">): number {
  return a.tasks.filter((t) => isAnswered(a.answers?.[t.id])).length;
}

export function answerText(value: MockAnswer | undefined): string {
  if (!isAnswered(value)) return "";
  return typeof value === "string" ? value.trim() : (value?.code ?? "");
}

/** «Олимпиада MAX · Математика · 4 класс» – the subject is always visible. */
export function mockTitle(m: Pick<MockTest, "title" | "subject">): string {
  const title = m.title.replace(/\s*[•·]\s*/g, " · ").trim();
  const subject = SUBJECT_LABEL[m.subject];
  const stem = m.subject === "info" ? "информатик" : "математик";
  if (!subject || title.toLowerCase().includes(stem)) return title;
  const parts = title.split(" · ");
  if (parts.length > 1) return [parts[0], subject, ...parts.slice(1)].join(" · ");
  return `${title} · ${subject}`;
}

/** Keys whose values differ between two answer maps; removed answers become `""`. */
export function changedAnswers(
  before: Record<string, MockAnswer>,
  after: Record<string, MockAnswer>,
): Record<string, MockAnswer> {
  const out: Record<string, MockAnswer> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = b ?? "";
  }
  return out;
}

export function isReviewedTask(t: PublicTask | ReviewedTask): t is ReviewedTask {
  return "solution" in t;
}

/** Topic to practise after a mock: the first task that went wrong. */
export function firstMistakeTopic(a: MockAttempt<ReviewedTask>): string | undefined {
  const wrong = a.tasks.find(
    (t) =>
      resultStatus(
        a.results?.find((r) => r.id === t.id),
        t,
      ) === "wrong",
  );
  return wrong?.topicId;
}
