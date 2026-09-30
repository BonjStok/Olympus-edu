"use client";
/** Shared bits of the teacher's area: header, record helpers, download. */
import { Button } from "@maxhub/max-ui";
import { LogOut, Smartphone } from "lucide-react";
import { useState } from "react";
import type { AdminRecord, ContentRecord, RecordKind, Topic } from "@/lib/domain/types";
import { errorMessage, isApiError } from "@/lib/client/api";
import { KIND_LABEL, SUBJECT_LABEL, gradesLabel } from "@/lib/ui/format";
import { plural, WORDS } from "@/lib/ui/plural";
import { useData } from "../state/data";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";

/**
 * Error of a teacher's action: a toast, and when the teacher mode has expired
 * (`ADMIN_EXPIRED` / `ADMIN_REQUIRED`) the data is reloaded so the sign-in form appears.
 */
export function useAdminFailure(): (e: unknown) => void {
  const data = useData();
  const toast = useToast();
  return (e: unknown) => {
    toast.error(errorMessage(e));
    if (isApiError(e) && e.action === "login") void data.load();
  };
}

export function AdminHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const logout = async () => {
    setPending(true);
    try {
      await data.api.call("admin-logout", {});
      await data.load();
      toast.success("Вы вышли из режима учителя");
      nav.reset({ tab: "profile", stack: [] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <header className="ol-admin-header">
      <div>
        <span className="ol-eyebrow">Кабинет учителя</span>
        <h1 tabIndex={-1}>{title}</h1>
        {subtitle && <p className="ol-page-subtitle">{subtitle}</p>}
      </div>
      <div className="ol-admin-header-actions">
        <Button
          variant="secondary"
          size="small"
          iconBefore={<Smartphone size={16} aria-hidden />}
          onClick={() => nav.reset({ tab: "home", stack: [] })}
        >
          К приложению
        </Button>
        {data.state.profile.admin && (
          <Button
            variant="secondary"
            size="small"
            loading={pending}
            iconBefore={<LogOut size={16} aria-hidden />}
            onClick={() => void logout()}
          >
            Выйти
          </Button>
        )}
      </div>
    </header>
  );
}

/** The version the teacher edits: the pending draft if there is one. */
export function editableVersion(r: AdminRecord | ContentRecord): ContentRecord {
  const draft = "draft" in r ? r.draft : null;
  const base = draft ?? r;
  const copy = JSON.parse(JSON.stringify(base)) as ContentRecord & { draft?: unknown };
  delete copy.draft;
  delete copy.unpublished;
  return copy;
}

/** The published version children see: the record without its pending draft. */
export function publishedVersion(r: AdminRecord | ContentRecord): ContentRecord {
  const copy = JSON.parse(JSON.stringify(r)) as ContentRecord & { draft?: unknown };
  delete copy.draft;
  delete copy.unpublished;
  return copy;
}

export function adminRecords(records: unknown[]): AdminRecord[] {
  return records.filter(
    (r): r is AdminRecord => !!r && typeof r === "object" && "kind" in r && "id" in r,
  ) as AdminRecord[];
}

/**
 * @param taskIds ids of the tasks that exist (not deleted), to warn about mocks that still point
 *   to deleted tasks
 */
export function recordSubtitle(
  r: ContentRecord,
  topics: readonly Topic[],
  taskIds?: ReadonlySet<string>,
): string {
  switch (r.kind) {
    case "olympiads":
      return `${SUBJECT_LABEL[r.subject] ?? ""} · ${gradesLabel(r.grades)} · ${r.region || "Вся Россия"}`;
    case "topics":
      return `${SUBJECT_LABEL[r.subject]} · ${r.grade} класс · №${r.order}`;
    case "lessons":
    case "tasks": {
      const topic = topics.find((t) => t.id === r.topicId);
      return `${SUBJECT_LABEL[r.subject]} · ${r.grade} класс · ${topic ? `тема «${topic.title}»` : "тема не выбрана"}`;
    }
    case "mock-tests": {
      const base = `${SUBJECT_LABEL[r.subject]} · ${r.grade} класс · ${plural(r.minutes, WORDS.minute)} · ${plural(r.taskIds.length, WORDS.task)}`;
      const deleted = taskIds ? r.taskIds.filter((id) => !taskIds.has(id)).length : 0;
      return deleted
        ? `${base} · удалено: ${plural(deleted, WORDS.task)} – откройте и уберите`
        : base;
    }
  }
}

export function downloadText(contents: string, name: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const KIND_TABS = (Object.keys(KIND_LABEL) as RecordKind[]).map((k) => ({
  value: k,
  label: KIND_LABEL[k],
}));
