"use client";
/**
 * Practice of a topic: task stepper, the task with its answer form and feedback next to
 * it, hint and (after a confirmation) the solution. Three own solutions give a star.
 */
import { Button, Input } from "@maxhub/max-ui";
import { AlertCircle, Check, CheckCircle2, Lightbulb, PartyPopper, Eye } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { PublicTask, Topic } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { haptic } from "@/lib/client/max-bridge";
import { isGenericTaskTitle, isNumericAnswer } from "@/lib/ui/format";
import { plural, WORDS } from "@/lib/ui/plural";
import { hasPracticeStar, PRACTICE_STAR_GOAL, taskState } from "@/lib/ui/progress";
import { recommendedTopic } from "@/lib/ui/learning";
import { ConfirmDialog } from "../shared/Dialog";
import { EmptyState } from "../shared/feedback";
import { useCatalog, useData } from "../state/data";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { useOpenTopic } from "../learn/LearnHome";
import { useTopicStatuses } from "../learn/topicData";
import { CodeWorkspace } from "./CodeWorkspace";
import { Prompt } from "./Prompt";

type Feedback = { correct: boolean; text: string } | null;

function TaskStepper({
  tasks,
  index,
  onPick,
}: {
  tasks: PublicTask[];
  index: number;
  onPick(i: number): void;
}) {
  const { state } = useData();
  return (
    <nav className="ol-stepper" aria-label="Задачи темы">
      {tasks.map((t, i) => {
        const st = taskState(state.progress, t.id);
        const label =
          st === "solved"
            ? ", решена"
            : st === "solved-after-reveal"
              ? ", решена после разбора"
              : st === "wrong"
                ? ", пока не решена"
                : "";
        return (
          <button
            key={t.id}
            type="button"
            className={`ol-step is-${st}${i === index ? " is-current" : ""}`}
            aria-current={i === index ? "step" : undefined}
            aria-label={`Задача ${i + 1}${label}`}
            onClick={() => onPick(i)}
          >
            {st === "solved" || st === "solved-after-reveal" ? (
              <Check size={18} aria-hidden />
            ) : (
              i + 1
            )}
          </button>
        );
      })}
    </nav>
  );
}

function NumberAnswer({
  task,
  onResult,
}: {
  task: PublicTask;
  onResult(r: { correct: boolean; practiceStar: boolean }): void;
}) {
  const data = useData();
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const value = answer.trim();
    if (!value) return setError("Сначала впиши ответ");
    if (!isNumericAnswer(value)) return setError("Нужно число, например 12 или 0,5");
    setError(null);
    setPending(true);
    try {
      const r = await data.checkTask(task, { answer: value });
      onResult(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="ol-answer"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="ol-field-label">
        Твой ответ
      </label>
      <div className="ol-answer-row">
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="Например, 12"
          value={answer}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            setAnswer(e.target.value);
            if (error) setError(null);
          }}
        />
        <Button type="submit" size="large" loading={pending}>
          Проверить
        </Button>
      </div>
      {error && (
        <p className="ol-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** One task with its own answer/hint/solution state (remounted for every task). */
function PracticeTask({
  topic,
  tasks,
  index,
  starJustEarned,
  onStarEarned,
}: {
  topic: Topic;
  tasks: PublicTask[];
  index: number;
  starJustEarned: boolean;
  onStarEarned(): void;
}) {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const catalog = useCatalog();
  const statusOf = useTopicStatuses();
  const openTopic = useOpenTopic();
  const task = tasks[index];
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [solution, setSolution] = useState<{ answer?: string; solution: string } | null>(null);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [pendingTool, setPendingTool] = useState<"hint" | "reveal" | "self" | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const progress = data.state.progress;
  const starred = hasPracticeStar(progress, topic.id);
  const status = statusOf(topic.id);
  const left = Math.max(0, Math.min(PRACTICE_STAR_GOAL, tasks.length) - status.solved);

  const go = (i: number) => {
    nav.replace({ name: "topic", id: topic.id, part: "practice", step: i });
    requestAnimationFrame(() =>
      cardRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
  };

  const onResult = (r: { correct: boolean; practiceStar: boolean }) => {
    if (r.correct) {
      haptic.success();
      setFeedback({ correct: true, text: "Верно! Отличная работа" });
    } else {
      haptic.error();
      setFeedback({ correct: false, text: "Пока неверно. Попробуй ещё раз или возьми подсказку" });
    }
    if (r.practiceStar) {
      onStarEarned();
      toast.success("Звезда за практику! ⭐");
    }
  };

  const showHint = async () => {
    setPendingTool("hint");
    setToolError(null);
    try {
      setHint(await data.hintFor(task.id));
    } catch (e) {
      setToolError(errorMessage(e));
    } finally {
      setPendingTool(null);
    }
  };

  const reveal = async () => {
    setPendingTool("reveal");
    setToolError(null);
    try {
      setSolution(await data.revealTask(task));
      setConfirmReveal(false);
    } catch (e) {
      setConfirmReveal(false);
      setToolError(errorMessage(e));
    } finally {
      setPendingTool(null);
    }
  };

  const selfCheck = async (correct: boolean) => {
    setPendingTool("self");
    try {
      onResult(await data.checkTask(task, { correct }));
    } catch (e) {
      setToolError(errorMessage(e));
    } finally {
      setPendingTool(null);
    }
  };

  const last = index === tasks.length - 1;
  const state = taskState(progress, task.id);
  const topicsOfPath = catalog.topics.filter(
    (t) => t.grade === topic.grade && t.subject === topic.subject,
  );
  const nextTopic = recommendedTopic(
    topicsOfPath.filter((t) => t.id !== topic.id),
    statusOf,
  );

  return (
    <div className="ol-practice-task">
      <p className="ol-star-goal">
        {starred
          ? "Звезда за практику получена ⭐ Можно решать дальше – для медалей."
          : left > 0
            ? `Реши ещё ${plural(left, WORDS.problemAcc)} – и получишь звезду за практику`
            : "Ещё одна верная задача – и звезда твоя!"}
      </p>

      <article className="ol-card ol-task" ref={cardRef} aria-labelledby={`task-${task.id}`}>
        <span className="ol-eyebrow">
          Задача {index + 1} из {tasks.length} · {plural(task.points ?? 1, WORDS.point)}
        </span>
        <h2
          id={`task-${task.id}`}
          className={isGenericTaskTitle(task.title) ? "ol-visually-hidden" : ""}
        >
          {isGenericTaskTitle(task.title) ? `Задача ${index + 1}` : task.title}
        </h2>
        <Prompt text={task.prompt} />
        {task.type === "code" && task.example && (
          <div className="ol-example-io">
            <div>
              <span className="ol-field-label">Пример входа</span>
              <pre>{task.example.input || "–"}</pre>
            </div>
            <div>
              <span className="ol-field-label">Пример выхода</span>
              <pre>{task.example.output || "–"}</pre>
            </div>
          </div>
        )}

        {state === "solved" && !feedback && (
          <p className="ol-note ol-note--ok">
            <CheckCircle2 size={18} aria-hidden /> Эта задача уже решена. Можно решить ещё раз.
          </p>
        )}
        {state === "solved-after-reveal" && !feedback && (
          <p className="ol-note">
            Задача решена после разбора – она не идёт в звёзды и медали, но потренироваться полезно.
          </p>
        )}

        {task.type === "number" && <NumberAnswer key={task.id} task={task} onResult={onResult} />}
        {task.type === "proof" && !solution && (
          <p className="ol-note">
            Запиши рассуждение на бумаге. Потом открой решение и честно сравни – задача засчитается,
            если всё сходится.
          </p>
        )}
        {task.type === "code" && (
          <CodeWorkspace
            key={task.id}
            task={task}
            runnerReady={data.state.features.runner}
            onChecked={onResult}
          />
        )}

        {feedback && (
          <div
            className={`ol-feedback ${feedback.correct ? "is-correct" : "is-wrong"}`}
            role="status"
            aria-live="polite"
          >
            {feedback.correct ? (
              <CheckCircle2 size={24} aria-hidden />
            ) : (
              <AlertCircle size={24} aria-hidden />
            )}
            <div>
              <b>{feedback.text}</b>
              {feedback.correct && !last && <p>Переходи к следующей задаче.</p>}
            </div>
          </div>
        )}

        <div className="ol-task-tools">
          {task.type !== "proof" && (
            <Button
              variant="ghost"
              size="medium"
              loading={pendingTool === "hint"}
              iconBefore={<Lightbulb size={18} aria-hidden />}
              onClick={() => void showHint()}
            >
              Подсказка
            </Button>
          )}
          {!solution && (
            <Button
              variant={task.type === "proof" ? "primary" : "ghost"}
              size="medium"
              iconBefore={<Eye size={18} aria-hidden />}
              onClick={() => (task.type === "proof" ? void reveal() : setConfirmReveal(true))}
              loading={task.type === "proof" && pendingTool === "reveal"}
            >
              {task.type === "proof" ? "Открыть решение и проверить себя" : "Посмотреть решение"}
            </Button>
          )}
        </div>
        {toolError && (
          <p className="ol-field-error" role="alert">
            {toolError}
          </p>
        )}
        {hint && (
          <div className="ol-hint" role="status">
            <Lightbulb size={20} aria-hidden />
            <p>{hint}</p>
          </div>
        )}
        {solution && (
          <div className="ol-solution" role="region" aria-label="Решение">
            {solution.answer && task.type === "number" && (
              <p className="ol-solution-answer">
                Ответ: <b>{solution.answer}</b>
              </p>
            )}
            <pre className="ol-solution-text">{solution.solution}</pre>
            {task.type === "proof" && (
              <div className="ol-actions">
                <Button
                  size="large"
                  stretched
                  loading={pendingTool === "self"}
                  onClick={() => void selfCheck(true)}
                >
                  У меня так же
                </Button>
                <Button
                  size="large"
                  stretched
                  variant="secondary"
                  disabled={pendingTool === "self"}
                  onClick={() => void selfCheck(false)}
                >
                  Есть ошибка
                </Button>
              </div>
            )}
          </div>
        )}

        {(starJustEarned || (last && starred && feedback?.correct)) && (
          <div className="ol-celebrate" role="status">
            <PartyPopper size={32} aria-hidden />
            <div>
              <b>Тема закреплена!</b>
              <p>
                {nextTopic
                  ? `Следующая тема – «${nextTopic.title}».`
                  : "Все темы этого класса пройдены – ты молодец!"}
              </p>
            </div>
          </div>
        )}

        <div className="ol-reader-footer">
          <Button
            variant="secondary"
            size="large"
            disabled={index === 0}
            onClick={() => go(index - 1)}
          >
            Назад
          </Button>
          {!last ? (
            <Button
              size="large"
              variant={feedback?.correct ? "primary" : "secondary"}
              onClick={() => go(index + 1)}
            >
              Дальше
            </Button>
          ) : nextTopic && (starred || starJustEarned) ? (
            <Button size="large" onClick={() => openTopic(nextTopic)}>
              Следующая тема
            </Button>
          ) : (
            <Button size="large" variant="secondary" onClick={() => nav.go("learn")}>
              К темам
            </Button>
          )}
        </div>
      </article>

      <ConfirmDialog
        open={confirmReveal}
        onOpenChange={setConfirmReveal}
        title="Точно открыть решение?"
        description="Разбор покажет ответ. После этого задача не пойдёт в звёзды и медали. Можно сначала взять подсказку."
        confirmLabel="Показать решение"
        cancelLabel="Ещё подумаю"
        pending={pendingTool === "reveal"}
        onConfirm={() => void reveal()}
      />
    </div>
  );
}

export function PracticeView({
  topic,
  tasks,
  step,
}: {
  topic: Topic;
  tasks: PublicTask[];
  step: number;
}) {
  const nav = useNav();
  const [starJustEarned, setStarJustEarned] = useState(false);
  const index = Math.min(step, Math.max(0, tasks.length - 1));
  const task = tasks[index];
  if (!task)
    return (
      <EmptyState
        title="Задачи скоро появятся"
        text="Учитель ещё готовит практику по этой теме."
        action={<Button onClick={() => nav.go("learn")}>К темам</Button>}
      />
    );
  return (
    <div className="ol-practice">
      <TaskStepper
        tasks={tasks}
        index={index}
        onPick={(i) => nav.replace({ name: "topic", id: topic.id, part: "practice", step: i })}
      />
      <PracticeTask
        key={task.id}
        topic={topic}
        tasks={tasks}
        index={index}
        starJustEarned={starJustEarned}
        onStarEarned={() => setStarJustEarned(true)}
      />
    </div>
  );
}
