"use client";
/**
 * Editor of one material: human form, inline errors with scroll-to-field, draft/publish,
 * a preview that shows what a child will see, and a guard against losing unsaved changes.
 * If the teacher session expired (403) the login opens right here and the action repeats.
 */
import { Button } from "@maxhub/max-ui";
import { Eye, Save, Send } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type {
  ContentRecord,
  Lesson,
  MockTest,
  Olympiad,
  RecordKind,
  Task,
  Topic,
} from "@/lib/domain/types";
import { errorMessage, isApiError } from "@/lib/client/api";
import {
  errorsFromServerMessage,
  firstErrorField,
  newRecord,
  prepareRecord,
  uniqueId,
  validateRecord,
  type FieldErrors,
} from "@/lib/ui/admin-records";
import { eventTiming } from "@/lib/ui/calendar";
import { todayIso } from "@/lib/ui/dates";
import { KIND_LABEL, KIND_LABEL_NEW, TASK_TYPE_LABEL } from "@/lib/ui/format";
import { plural, WORDS } from "@/lib/ui/plural";
import { EventCard } from "../calendar/EventCard";
import { Blocks } from "../shared/Blocks";
import { ConfirmDialog, Dialog } from "../shared/Dialog";
import { EmptyState } from "../shared/feedback";
import { BackLink } from "../shared/layout";
import { useData } from "../state/data";
import { useLearner } from "../state/learner";
import { useLeaveGuard, useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { Prompt } from "../training/Prompt";
import { AdminLoginForm } from "./AdminLogin";
import { AdminHeader, adminRecords, editableVersion } from "./common";
import { LessonEditor, MockEditor, OlympiadEditor, TaskEditor, TopicEditor } from "./editors";
import { AField, control, fieldId } from "./fields";

function Preview({ record }: { record: ContentRecord }) {
  const today = todayIso();
  switch (record.kind) {
    case "olympiads":
      return (
        <EventCard
          entry={{
            kind: "event",
            key: record.id,
            event: record,
            timing: eventTiming(record, today),
          }}
          registered={false}
          year={Number(today.slice(0, 4))}
          onOpen={() => undefined}
        />
      );
    case "lessons":
      return (
        <article className="ol-card ol-lesson">
          <h2>{record.title}</h2>
          <Blocks blocks={record.blocks} />
        </article>
      );
    case "tasks":
      return (
        <article className="ol-card ol-task">
          <span className="ol-eyebrow">
            {TASK_TYPE_LABEL[record.type]} · {plural(record.points ?? 1, WORDS.point)}
          </span>
          <h2>{record.title}</h2>
          <Prompt text={record.prompt} />
          <div className="ol-solution">
            <span className="ol-field-label">Разбор</span>
            {record.type === "number" && (
              <p className="ol-solution-answer">
                Ответ: <b>{record.answer}</b>
              </p>
            )}
            <pre className="ol-solution-text">{record.solution}</pre>
          </div>
        </article>
      );
    case "topics":
      return (
        <article className="ol-card">
          <h2>{record.title}</h2>
          <p>{record.description}</p>
        </article>
      );
    case "mock-tests":
      return (
        <article className="ol-card ol-mock-card">
          <h2>{record.title}</h2>
          <p>
            {plural(record.minutes, WORDS.minute)} ·{" "}
            {plural(record.randomize ? (record.taskCount ?? 0) : record.taskIds.length, WORDS.task)}
          </p>
        </article>
      );
  }
}

export default function AdminEditorScreen({ kind, id }: { kind: RecordKind; id: string }) {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const learner = useLearner();
  const records = adminRecords(data.state.records);
  const topics = records.filter((r) => r.kind === "topics") as unknown as Topic[];
  const tasks = records.filter((r) => r.kind === "tasks") as unknown as Task[];
  const isNew = id === "new";
  const source = isNew ? undefined : records.find((r) => r.id === id);
  const initial = useMemo<ContentRecord | null>(
    () =>
      isNew
        ? newRecord(kind, { topics }, { grade: learner.grade, subject: learner.subject })
        : source
          ? editableVersion(source)
          : null,
    // Initial value only: later record reloads must not overwrite the teacher's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [record, setRecord] = useState<ContentRecord | null>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [dirty, setDirty] = useState(false);
  const [idTouched, setIdTouched] = useState(!isNew);
  const [pending, setPending] = useState<"draft" | "publish" | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [leave, setLeave] = useState<null | (() => void)>(null);
  const [login, setLogin] = useState<null | "draft" | "publish">(null);
  const formRef = useRef<HTMLFormElement>(null);

  const existingIds = useMemo(
    () => new Set(records.map((r) => r.id).filter((x) => isNew || x !== id)),
    [records, id, isNew],
  );

  useLeaveGuard(dirty && !pending, (proceed) => {
    setLeave(() => proceed);
    return true;
  });

  if (!record)
    return (
      <div className="ol-screen ol-admin">
        <AdminHeader title="Материал не найден" />
        <EmptyState
          title="Такого материала нет"
          text="Возможно, его удалили. Вернитесь к списку."
          action={<Button onClick={() => nav.back()}>К списку</Button>}
        />
      </div>
    );

  const update = (patch: Partial<ContentRecord>) => {
    setRecord((r) => {
      if (!r) return r;
      const next = { ...r, ...patch } as ContentRecord;
      if (!idTouched && "title" in patch && isNew) next.id = uniqueId(next.title, existingIds);
      return next;
    });
    setDirty(true);
    // Clear the error of a field as soon as it is edited.
    const keys = Object.keys(patch);
    if (keys.some((k) => errors[k]))
      setErrors((e) =>
        Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k.split(".")[0]))),
      );
  };

  const focusFirstError = (errs: FieldErrors) => {
    const key = firstErrorField(errs);
    if (!key) return;
    requestAnimationFrame(() => {
      const el =
        document.getElementById(fieldId(key)) ??
        formRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`);
      el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      (el?.matches("input,textarea,select,button")
        ? el
        : el?.querySelector<HTMLElement>("input,textarea,select,button")
      )?.focus({ preventScroll: true });
    });
  };

  const fieldOnForm = (key: string) =>
    !!document.getElementById(fieldId(key)) ||
    !!formRef.current?.querySelector(`[data-field="${key}"]`);

  /** Errors next to their fields; one that has no field on this form goes next to the buttons. */
  const showErrors = (errs: FieldErrors) => {
    setErrors(errs);
    const unplaced = Object.entries(errs).find(([key]) => !fieldOnForm(key.split(".")[0]));
    setServerError(unplaced ? unplaced[1] : null);
  };

  const save = async (mode: "draft" | "publish") => {
    const withId =
      isNew && !idTouched ? { ...record, id: uniqueId(record.title, existingIds) } : record;
    const prepared = prepareRecord(withId as ContentRecord);
    const errs = validateRecord(prepared, { topics, tasks, existingIds });
    // Without a title the code cannot be made yet – the title error is enough.
    if (errs.title && !idTouched) delete errs.id;
    showErrors(errs);
    if (Object.keys(errs).length) {
      toast.error(
        `Проверьте ${plural(Object.keys(errs).length, ["поле", "поля", "полей"])} – они подсвечены`,
      );
      focusFirstError(errs);
      return;
    }
    setPending(mode);
    try {
      await data.api.call(mode === "draft" ? "draft" : "publish", { record: prepared });
      await data.load();
      setDirty(false);
      nav.setGuard(null);
      if (mode === "publish") {
        toast.success(`Опубликовано: «${prepared.title}». Дети уже видят изменения`);
        nav.back();
      } else {
        toast.success("Черновик сохранён. Дети его не видят, пока вы не опубликуете");
        if (isNew) nav.replace({ name: "admin-edit", kind, id: prepared.id });
      }
    } catch (e) {
      // ADMIN_EXPIRED / ADMIN_REQUIRED: sign in again right here, the form stays filled.
      if (isApiError(e) && (e.action === "login" || e.status === 401)) {
        setLogin(mode);
      } else if (isApiError(e) && e.code === "VALIDATION_ERROR") {
        // The server's rule, placed at its field like the editor's own checks.
        const errs = errorsFromServerMessage(e.serverMessage || e.message, prepared.id);
        showErrors(errs);
        focusFirstError(errs);
      } else setServerError(errorMessage(e));
    } finally {
      setPending(null);
    }
  };

  const Editor = {
    olympiads: OlympiadEditor,
    topics: TopicEditor,
    lessons: LessonEditor,
    tasks: TaskEditor,
    "mock-tests": MockEditor,
  }[kind] as (p: {
    value: ContentRecord;
    onChange(p: Partial<ContentRecord>): void;
    errors: FieldErrors;
    topics: readonly Topic[];
    tasks: readonly Task[];
  }) => React.JSX.Element;

  return (
    <div className="ol-screen ol-admin ol-admin-editor">
      <BackLink label={KIND_LABEL[kind]} />
      <AdminHeader
        title={record.title || (isNew ? KIND_LABEL_NEW[kind] : "Без названия")}
        subtitle={
          source && "draft" in source && source.draft
            ? "Есть неопубликованный черновик – вы редактируете его"
            : undefined
        }
      />
      <form
        ref={formRef}
        className="ol-card ol-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save("publish");
        }}
      >
        <Editor value={record} onChange={update} errors={errors} topics={topics} tasks={tasks} />
        <details className="ol-advanced" open={!!errors.id}>
          <summary>Дополнительно</summary>
          <AField
            name="id"
            label="Код материала"
            error={errors.id}
            hint={
              isNew
                ? "Создаётся из названия. Менять не обязательно"
                : "Код уже используется ссылками – лучше не менять"
            }
          >
            <input
              {...control("id", errors.id)}
              className="ol-input"
              value={record.id}
              readOnly={!isNew}
              onChange={(e) => {
                setIdTouched(true);
                update({ id: e.target.value.trim() });
              }}
            />
          </AField>
          {record.kind === "olympiads" && (
            <AField
              name="series"
              label="Группа региональных выпусков"
              optional
              error={errors.series}
              hint="Одинаковый код у выпусков одной олимпиады в разных регионах: без выбранного региона дети увидят одну карточку"
            >
              <input
                {...control("series")}
                className="ol-input"
                value={(record as Olympiad).series ?? ""}
                onChange={(e) =>
                  update({ series: e.target.value.trim() || undefined } as Partial<Olympiad>)
                }
              />
            </AField>
          )}
        </details>
        {serverError && (
          <p className="ol-field-error ol-form-error" role="alert">
            Не получилось сохранить: {serverError}
          </p>
        )}
        <div className="ol-form-actions">
          <Button
            type="button"
            variant="secondary"
            size="large"
            loading={pending === "draft"}
            disabled={!!pending}
            iconBefore={<Save size={18} aria-hidden />}
            onClick={() => void save("draft")}
          >
            Сохранить черновик
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="large"
            disabled={!!pending}
            iconBefore={<Eye size={18} aria-hidden />}
            onClick={() => setPreview(true)}
          >
            Как увидят дети
          </Button>
          <Button
            type="submit"
            size="large"
            loading={pending === "publish"}
            disabled={!!pending}
            iconBefore={<Send size={18} aria-hidden />}
          >
            Опубликовать
          </Button>
        </div>
      </form>

      <Dialog open={preview} onOpenChange={setPreview} title="Так материал увидят дети" size="wide">
        <Preview record={prepareRecord(record) as Olympiad | Topic | Lesson | Task | MockTest} />
      </Dialog>
      <Dialog
        open={!!login}
        onOpenChange={(v) => !v && setLogin(null)}
        title="Войдите снова"
        description="Режим учителя закрылся после перерыва. Форма заполнена – после входа сохраним её."
      >
        <AdminLoginForm
          onSuccess={() => {
            const mode = login;
            setLogin(null);
            if (mode) void save(mode);
          }}
        />
      </Dialog>
      <ConfirmDialog
        open={!!leave}
        onOpenChange={(v) => !v && setLeave(null)}
        title="Выйти без сохранения?"
        description="Изменения в форме пропадут. Можно сначала сохранить черновик."
        confirmLabel="Выйти"
        cancelLabel="Остаться"
        destructive
        onConfirm={() => {
          const proceed = leave;
          setLeave(null);
          setDirty(false);
          proceed?.();
        }}
      />
    </div>
  );
}
