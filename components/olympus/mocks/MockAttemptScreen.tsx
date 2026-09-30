"use client";
/**
 * A mock attempt. Always starts from a fresh copy from the server (answers are never lost
 * on «Продолжить»), autosaves changed answers, keeps the timer, asks before leaving and
 * asks MAX to confirm closing while it runs. Finished attempts show the review.
 */
import { Button } from "@maxhub/max-ui";
import { Clock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MockAnswer, MockAttempt, PublicTask, ReviewedTask } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { serverNow } from "@/lib/client/clock";
import { haptic, setClosingConfirmation } from "@/lib/client/max-bridge";
import { formatCountdown } from "@/lib/ui/dates";
import { isGenericTaskTitle, isNumericAnswer } from "@/lib/ui/format";
import { answeredCount, changedAnswers, isAnswered, mockTitle } from "@/lib/ui/mocks";
import { plural, WORDS } from "@/lib/ui/plural";
import { useCountdown } from "../hooks/useCountdown";
import { useDebouncedSave, type SaveStatus } from "../hooks/useDebouncedSave";
import { ConfirmDialog } from "../shared/Dialog";
import { useResource } from "../hooks/useResource";
import { ErrorBanner, Loading } from "../shared/feedback";
import { PageHeader } from "../shared/layout";
import { useData } from "../state/data";
import { useLeaveGuard, useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { CodeEditor } from "../training/CodeWorkspace";
import { Prompt } from "../training/Prompt";
import { MockResults } from "./MockResults";

const SAVE_TEXT: Record<SaveStatus, string> = {
  idle: "Ответы сохраняются автоматически",
  pending: "Сохраняем…",
  saving: "Сохраняем…",
  saved: "Ответы сохранены",
  error: "Нет связи – ответы сохраним, когда связь вернётся",
};

function AnswerInput({
  task,
  value,
  onChange,
}: {
  task: PublicTask;
  value: MockAnswer | undefined;
  onChange(v: MockAnswer): void;
}) {
  if (task.type === "code") {
    const v =
      typeof value === "object" && value ? value : { code: "", language: "python" as const };
    return <CodeEditor value={v} onChange={onChange} label="Твоя программа" />;
  }
  const text = typeof value === "string" ? value : "";
  const id = `mock-answer-${task.id}`;
  if (task.type === "proof")
    return (
      <div className="ol-field">
        <label className="ol-field-label" htmlFor={id}>
          Твоё рассуждение
        </label>
        <textarea
          id={id}
          className="ol-textarea"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="ol-field-hint">После финиша сравнишь его с разбором и оценишь</p>
      </div>
    );
  const invalid = text.trim() !== "" && !isNumericAnswer(text);
  return (
    <div className="ol-field">
      <label className="ol-field-label" htmlFor={id}>
        Твой ответ
      </label>
      <input
        id={id}
        className="ol-input"
        inputMode="decimal"
        autoComplete="off"
        placeholder="Например, 12"
        value={text}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalid && (
        <p className="ol-field-error" id={`${id}-error`} role="alert">
          Нужно число, например 12 или 0,5 – иначе ответ не засчитается
        </p>
      )}
    </div>
  );
}

function MockRunner({
  initial,
  onFinished,
}: {
  initial: MockAttempt<PublicTask>;
  onFinished(a: MockAttempt<ReviewedTask>): void;
}) {
  const data = useData();
  const toast = useToast();
  const id = initial.id;
  const [answers, setAnswers] = useState<Record<string, MockAnswer>>(initial.answers ?? {});
  const answersRef = useRef(answers);
  const saved = useRef<Record<string, MockAnswer>>(initial.answers ?? {});
  const [step, setStep] = useState(() => {
    const i = initial.tasks.findIndex((t) => !isAnswered(initial.answers?.[t.id]));
    return i < 0 ? 0 : i;
  });
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [leave, setLeave] = useState<null | (() => void)>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const warned = useRef({ five: false, one: false });
  const cardRef = useRef<HTMLElement>(null);

  const finishedRef = useRef(false);
  /** The server finished the attempt itself (time is over, or it was finished elsewhere). */
  const endedByServer = useCallback(
    (done: MockAttempt) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      haptic.warning();
      toast.info("Время вышло – пробник завершён. Смотри результат");
      onFinished(done as MockAttempt<ReviewedTask>);
    },
    [onFinished, toast],
  );

  const save = useDebouncedSave<Record<string, MockAnswer>>(async (next, opts) => {
    const changed = changedAnswers(saved.current, next);
    if (!Object.keys(changed).length) return;
    // `mock-save` answers with the finished attempt once the time is over (never an error).
    const done = await data.saveMockAnswers(id, next, changed, { keepalive: opts.keepalive });
    saved.current = next;
    if (done?.finished) endedByServer(done);
  }, 600);

  const finish = useCallback(
    async (auto: boolean) => {
      if (finishing || finishedRef.current) return;
      setFinishing(true);
      setFinishError(null);
      try {
        await save.flush().catch(() => undefined);
        if (finishedRef.current) return;
        const done = await data.finishMock(id, answersRef.current);
        if (finishedRef.current) return;
        finishedRef.current = true;
        haptic.success();
        toast.success(
          auto ? "Время вышло – пробник завершён. Смотри результат" : "Пробник завершён!",
        );
        onFinished(done);
      } catch (e) {
        setFinishError(errorMessage(e));
        haptic.error();
      } finally {
        setFinishing(false);
        setConfirmFinish(false);
      }
    },
    [data, finishing, id, onFinished, save, toast],
  );

  /** Re-reads the attempt: the response also corrects the server clock estimate. */
  const syncWithServer = useCallback(async () => {
    const fresh = await data.fetchAttempt(id).catch(() => null);
    if (fresh?.finished) endedByServer(fresh);
    return fresh;
  }, [data, id, endedByServer]);

  const onExpire = useCallback(async () => {
    // The device clock may have jumped ahead: finish only when the server agrees time is up.
    const fresh = await syncWithServer();
    if (finishedRef.current) return;
    if (fresh && !fresh.finished && fresh.ends - serverNow() > 2000) return;
    void finish(true);
  }, [syncWithServer, finish]);

  const left = useCountdown(initial.ends, () => void onExpire());

  // Back from the background (screen locked, another app): the attempt may be over already.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncWithServer();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [syncWithServer]);

  // Warnings near the end; each also re-checks the clock with the server, so a device clock
  // changed during the attempt cannot move the real end.
  useEffect(() => {
    if (left <= 60_000 && left > 0 && !warned.current.one) {
      warned.current.one = true;
      warned.current.five = true;
      haptic.warning();
      toast.info("Осталась 1 минута! Проверь ответы");
      void syncWithServer();
    } else if (left <= 5 * 60_000 && left > 60_000 && !warned.current.five) {
      warned.current.five = true;
      haptic.warning();
      toast.info("Осталось 5 минут");
      void syncWithServer();
    }
  }, [left, toast, syncWithServer]);

  // MAX asks before closing the app while the timer runs.
  useEffect(() => {
    setClosingConfirmation(true);
    return () => setClosingConfirmation(false);
  }, []);

  useLeaveGuard(!finishing, (proceed) => {
    setLeave(() => proceed);
    return true;
  });

  const setAnswer = (taskId: string, value: MockAnswer) => {
    const next = { ...answersRef.current, [taskId]: value };
    answersRef.current = next;
    setAnswers(next);
    save.schedule(next);
  };

  const go = (i: number) => {
    setStep(i);
    haptic.selection();
    requestAnimationFrame(() =>
      cardRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
  };

  const task = initial.tasks[step];
  const answered = answeredCount({ tasks: initial.tasks, answers });
  const total = initial.tasks.length;
  const tone = left <= 60_000 ? "danger" : left <= 5 * 60_000 ? "warn" : "ok";

  return (
    <div className="ol-screen ol-attempt">
      <PageHeader
        back="Пробники"
        eyebrow="Пробный тур"
        title={mockTitle({ title: initial.title, subject: initial.subject })}
      />
      <div className="ol-attempt-bar" role="group" aria-label="Состояние пробника">
        <span
          className={`ol-timer ol-timer--${tone}`}
          role="timer"
          aria-live="off"
          aria-label={`Осталось ${formatCountdown(left)}`}
        >
          <Clock size={20} aria-hidden />
          {formatCountdown(left)}
        </span>
        <span className="ol-attempt-progress">
          Отвечено {answered} из {total}
          <small className={`ol-save-status ol-save-status--${save.status}`} aria-live="polite">
            {SAVE_TEXT[save.status]}
          </small>
        </span>
        {step < total - 1 && (
          <Button size="small" variant="secondary" onClick={() => setConfirmFinish(true)}>
            Завершить
          </Button>
        )}
      </div>

      <nav className="ol-stepper ol-stepper--wrap" aria-label="Задания пробника">
        {initial.tasks.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={`ol-step${i === step ? " is-current" : ""}${isAnswered(answers[t.id]) ? " is-answered" : ""}`}
            aria-current={i === step ? "step" : undefined}
            aria-label={`Задание ${i + 1}${isAnswered(answers[t.id]) ? ", есть ответ" : ", без ответа"}`}
            onClick={() => go(i)}
          >
            {i + 1}
          </button>
        ))}
      </nav>

      {task && (
        <article className="ol-card ol-task" ref={cardRef} aria-labelledby={`mock-task-${task.id}`}>
          <span className="ol-eyebrow" id={`mock-task-${task.id}`}>
            Задание {step + 1} из {total} · {plural(task.points ?? 1, WORDS.point)}
          </span>
          {!isGenericTaskTitle(task.title) && <h2>{task.title}</h2>}
          <Prompt text={task.prompt} />
          <AnswerInput
            key={task.id}
            task={task}
            value={answers[task.id]}
            onChange={(v) => setAnswer(task.id, v)}
          />
          <div className="ol-reader-footer">
            <Button
              variant="secondary"
              size="large"
              disabled={step === 0}
              onClick={() => go(step - 1)}
            >
              Назад
            </Button>
            {step < total - 1 ? (
              <Button size="large" onClick={() => go(step + 1)}>
                Дальше
              </Button>
            ) : (
              <Button size="large" onClick={() => setConfirmFinish(true)}>
                Завершить
              </Button>
            )}
          </div>
        </article>
      )}
      <p className="ol-note">Решай в любом порядке. Подсказки и разборы откроются после финиша.</p>
      {finishError && (
        <ErrorBanner
          title="Не получилось завершить"
          message={finishError}
          onRetry={() => void finish(false)}
          retrying={finishing}
        />
      )}

      <ConfirmDialog
        open={confirmFinish}
        onOpenChange={setConfirmFinish}
        title="Завершить пробник?"
        description={
          answered < total
            ? `Отвечено ${answered} из ${plural(total, WORDS.taskGen)}. После завершения ответы изменить нельзя, зато сразу откроются разборы.`
            : "Все задания с ответами. После завершения ответы изменить нельзя, зато сразу откроются разборы."
        }
        confirmLabel="Завершить"
        cancelLabel="Ещё порешаю"
        pending={finishing}
        onConfirm={() => void finish(false)}
      />
      <ConfirmDialog
        open={!!leave}
        onOpenChange={(v) => !v && setLeave(null)}
        title="Выйти из пробника?"
        description="Таймер продолжит идти, ответы сохранены. Вернуться можно из раздела «Пробники» или по плашке сверху."
        confirmLabel="Выйти"
        cancelLabel="Остаться"
        onConfirm={() => {
          const proceed = leave;
          setLeave(null);
          void save.flush().finally(() => proceed?.());
        }}
      />
    </div>
  );
}

export function MockAttemptScreen({ id }: { id: string }) {
  const data = useData();
  const nav = useNav();
  const cached = data.state.progress[`attempt:${id}`] as MockAttempt | undefined;
  const finishedCopy = cached?.finished ? cached : null;
  // A running attempt is always re-read from the server: never continue from a stale copy.
  const resource = useResource(() => data.fetchAttempt(id), {
    initial: finishedCopy,
    skip: !!finishedCopy,
  });
  const [override, setOverride] = useState<MockAttempt | null>(null);
  const attempt = override ?? finishedCopy ?? resource.data;

  if (!attempt)
    return (
      <div className="ol-screen">
        <PageHeader
          back="Пробники"
          eyebrow="Пробный тур"
          title={cached ? mockTitle({ title: cached.title, subject: cached.subject }) : "Пробник"}
        />
        {resource.error ? (
          <ErrorBanner
            title="Не получилось открыть пробник"
            message={resource.error}
            onRetry={resource.retry}
            action={
              resource.errorAction === "back" ? (
                <Button size="small" variant="secondary" onClick={() => nav.go("mocks")}>
                  К пробникам
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Loading label="Загружаем твои ответы…" />
        )}
      </div>
    );

  if (attempt.finished)
    return <MockResults attempt={attempt as MockAttempt<ReviewedTask>} onChange={setOverride} />;
  return (
    <MockRunner
      initial={attempt as MockAttempt<PublicTask>}
      onFinished={(a) => {
        setOverride(a);
        window.scrollTo({ top: 0 });
      }}
    />
  );
}
