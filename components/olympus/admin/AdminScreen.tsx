"use client";
/**
 * Teacher's area: materials by kind, search, add, import (table or JSON), export,
 * version history, deleted materials. No child navigation here.
 */
import { Button, CellList, CellSimple, Input, Icon16SearchOutline } from "@maxhub/max-ui";
import { Download, History, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import type { AdminRecord, ContentRecord, RecordKind, Revision, Topic } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/ui/dates";
import { KIND_LABEL, KIND_LABEL_ACC } from "@/lib/ui/format";
import { plural, WORDS } from "@/lib/ui/plural";
import { ConfirmDialog, Dialog } from "../shared/Dialog";
import { Segmented } from "../shared/controls";
import { useResource } from "../hooks/useResource";
import { EmptyState, Loading } from "../shared/feedback";
import { useData } from "../state/data";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { AdminLogin } from "./AdminLogin";
import {
  AdminHeader,
  KIND_TABS,
  useAdminFailure,
  adminRecords,
  downloadText,
  editableVersion,
  publishedVersion,
  recordSubtitle,
} from "./common";
import { ImportDialog } from "./ImportDialog";

const PAGE = 60;

function HistoryList({ id, onRestored }: { id: string; onRestored(): void }) {
  const data = useData();
  const toast = useToast();
  const [restoring, setRestoring] = useState<string | null>(null);
  const fail = useAdminFailure();
  const history = useResource(() => data.api.call("history", { id }).then((r) => r.history));

  const restore = async (rev: Revision) => {
    setRestoring(rev.id);
    try {
      await data.api.call("restore", { revisionId: rev.id });
      await data.load();
      toast.success("Версия восстановлена в черновик. Откройте материал и опубликуйте");
      onRestored();
    } catch (e) {
      fail(e);
    } finally {
      setRestoring(null);
    }
  };

  if (history.error)
    return (
      <p className="ol-field-error" role="alert">
        {history.error}
      </p>
    );
  if (!history.data) return <Loading label="Загружаем версии…" />;
  if (!history.data.length)
    return (
      <p className="ol-note">
        Предыдущих версий пока нет – они появятся после следующей публикации.
      </p>
    );
  return (
    <ul className="ol-admin-history">
      {history.data.map((rev) => (
        <li key={rev.id}>
          <div>
            <b>{formatDateTime(rev.created)}</b>
            <span>{rev.data.title}</span>
          </div>
          <Button
            size="small"
            variant="secondary"
            loading={restoring === rev.id}
            iconBefore={<RotateCcw size={16} aria-hidden />}
            onClick={() => void restore(rev)}
          >
            Восстановить
          </Button>
        </li>
      ))}
    </ul>
  );
}

function HistoryDialog({
  record,
  onClose,
}: {
  record: Pick<ContentRecord, "id" | "title"> | null;
  onClose(): void;
}) {
  return (
    <Dialog
      open={!!record}
      onOpenChange={(v) => !v && onClose()}
      title="История изменений"
      description={record?.title}
    >
      {record && <HistoryList key={record.id} id={record.id} onRestored={onClose} />}
    </Dialog>
  );
}

function DeletedList({ onHistory }: { onHistory(r: ContentRecord): void }) {
  const data = useData();
  const deleted = useResource(() => data.api.call("deleted", {}).then((r) => r.deleted));
  if (deleted.error)
    return (
      <p className="ol-field-error" role="alert">
        {deleted.error}
      </p>
    );
  if (!deleted.data) return <Loading />;
  if (!deleted.data.length) return <p className="ol-note">Корзина пуста.</p>;
  return (
    <ul className="ol-admin-history">
      {deleted.data.map((r) => (
        <li key={r.id}>
          <div>
            <b>{r.title}</b>
            <span>{KIND_LABEL[r.kind]}</span>
          </div>
          <Button size="small" variant="secondary" onClick={() => onHistory(r)}>
            Вернуть
          </Button>
        </li>
      ))}
    </ul>
  );
}

function DeletedDialog({
  open,
  onClose,
  onHistory,
}: {
  open: boolean;
  onClose(): void;
  onHistory(r: ContentRecord): void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Удалённые материалы"
      description="Удалённое можно вернуть: выберите версию в истории"
    >
      {open && <DeletedList onHistory={onHistory} />}
    </Dialog>
  );
}

function AdminHome({ kind }: { kind: RecordKind }) {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [importOpen, setImportOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<Pick<ContentRecord, "id" | "title"> | null>(null);
  const [deleting, setDeleting] = useState<AdminRecord | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const fail = useAdminFailure();
  const records = adminRecords(data.state.records);
  const topics = records.filter((r): r is AdminRecord & Topic => r.kind === "topics");
  const taskIds = new Set(records.filter((r) => r.kind === "tasks").map((r) => r.id));
  const q = query.trim().toLowerCase();
  const list = records
    .filter((r) => r.kind === kind)
    .filter((r) => !q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));

  const remove = async () => {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await data.api.call("delete", { id: deleting.id });
      await data.load();
      toast.success(`«${deleting.title}» удалено. Вернуть можно из корзины`);
      setDeleting(null);
    } catch (e) {
      fail(e);
    } finally {
      setDeletePending(false);
    }
  };

  const ofKind = records.filter((r) => r.kind === kind);
  const drafts = ofKind.filter((r) => r.draft || r.unpublished);
  /** What children see right now: published versions only, without pending drafts. */
  const exportPublished = () => {
    const items = ofKind.filter((r) => !r.unpublished).map((r) => publishedVersion(r));
    downloadText(JSON.stringify(items, null, 2), `${kind}.json`);
  };
  /** Pending drafts (as the teacher edits them), e.g. to review before publishing. */
  const exportDrafts = () => {
    const items = drafts.map((r) => editableVersion(r));
    downloadText(JSON.stringify(items, null, 2), `${kind}-drafts.json`);
  };

  return (
    <>
      <AdminHeader
        title={KIND_LABEL[kind]}
        subtitle="Черновик видите только вы. Дети увидят материал после «Опубликовать»"
      />
      <Segmented
        label="Раздел"
        className="ol-admin-kinds"
        value={kind}
        options={KIND_TABS}
        onChange={(k) => {
          setQuery("");
          setLimit(PAGE);
          nav.replace({ name: "admin", kind: k });
        }}
      />
      <div className="ol-admin-toolbar">
        <Button
          size="medium"
          iconBefore={<Plus size={18} aria-hidden />}
          onClick={() => nav.push({ name: "admin-edit", kind, id: "new" })}
        >
          Добавить {KIND_LABEL_ACC[kind]}
        </Button>
        <Button
          size="medium"
          variant="secondary"
          iconBefore={<Upload size={18} aria-hidden />}
          onClick={() => setImportOpen(true)}
        >
          Импорт из файла
        </Button>
        <Button
          size="medium"
          variant="secondary"
          iconBefore={<Download size={18} aria-hidden />}
          onClick={exportPublished}
        >
          Скачать опубликованное
        </Button>
        {drafts.length > 0 && (
          <Button
            size="medium"
            variant="secondary"
            iconBefore={<Download size={18} aria-hidden />}
            onClick={exportDrafts}
          >
            Скачать черновики ({drafts.length})
          </Button>
        )}
        <Button
          size="medium"
          variant="ghost"
          iconBefore={<Trash2 size={18} aria-hidden />}
          onClick={() => setDeletedOpen(true)}
        >
          Корзина
        </Button>
      </div>
      <div className="ol-topic-search">
        <Input
          aria-label="Найти материал"
          placeholder="Найти по названию"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
          iconBefore={<Icon16SearchOutline />}
          withClearButton
        />
      </div>
      <p className="ol-muted" aria-live="polite">
        {plural(list.length, WORDS.material)}
      </p>
      {!list.length ? (
        <EmptyState
          title="Здесь пока пусто"
          text={query ? "Ничего не нашли – измените запрос." : "Добавьте первый материал."}
        />
      ) : (
        <CellList mode="island" className="ol-admin-list">
          {list.slice(0, limit).map((r) => (
            <CellSimple
              key={r.id}
              title={r.title || "Без названия"}
              subtitle={recordSubtitle(editableVersion(r), topics, taskIds)}
              after={
                <span className="ol-cell-actions">
                  {(r.draft || r.unpublished) && (
                    <span className="ol-badge ol-badge--warn">Черновик</span>
                  )}
                  {r.demo && <span className="ol-badge ol-badge--demo">Пример</span>}
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => nav.push({ name: "admin-edit", kind, id: r.id })}
                  >
                    Изменить
                  </Button>
                  <button
                    type="button"
                    className="ol-icon-btn"
                    aria-label={`История: ${r.title}`}
                    onClick={() => setHistoryFor(r)}
                  >
                    <History size={18} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ol-icon-btn"
                    aria-label={`Удалить: ${r.title}`}
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 size={18} aria-hidden />
                  </button>
                </span>
              }
            />
          ))}
        </CellList>
      )}
      {list.length > limit && (
        <Button variant="secondary" stretched onClick={() => setLimit((l) => l + PAGE)}>
          Показать ещё {Math.min(PAGE, list.length - limit)}
        </Button>
      )}

      <ImportDialog open={importOpen} kind={kind} onClose={() => setImportOpen(false)} />
      <DeletedDialog
        open={deletedOpen}
        onClose={() => setDeletedOpen(false)}
        onHistory={(r) => {
          setDeletedOpen(false);
          setHistoryFor(r);
        }}
      />
      <HistoryDialog record={historyFor} onClose={() => setHistoryFor(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Удалить материал?"
        description={
          deleting
            ? `«${deleting.title}» исчезнет у детей. Их достижения сохранятся, а материал можно вернуть из корзины.`
            : undefined
        }
        confirmLabel="Удалить"
        destructive
        pending={deletePending}
        onConfirm={() => void remove()}
      />
    </>
  );
}

export default function AdminScreen({ kind }: { kind: RecordKind }) {
  const data = useData();
  const nav = useNav();
  return (
    <div className="ol-screen ol-admin">
      {data.state.profile.admin ? (
        <AdminHome kind={kind} />
      ) : (
        <>
          <AdminHeader title="Вход" />
          <AdminLogin onBack={() => nav.reset({ tab: "profile", stack: [] })} />
        </>
      )}
    </div>
  );
}
