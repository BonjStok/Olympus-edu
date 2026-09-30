"use client";
/**
 * «Учёба»: one path of topics for the child's class and subject. Each topic has theory
 * (lessons) and practice (tasks) and gives two stars; the next topic is highlighted.
 */
import { Button, Input, Icon16SearchOutline } from "@maxhub/max-ui";
import { BookOpen, Dumbbell, SearchX, Star } from "lucide-react";
import { useMemo, useState } from "react";
import type { Subject, Topic } from "@/lib/domain/types";
import { haptic } from "@/lib/client/max-bridge";
import {
  entryPart,
  firstUnfinished,
  recommendedTopic,
  tasksToStar,
  type TopicStatus,
} from "@/lib/ui/learning";
import { plural, WORDS } from "@/lib/ui/plural";
import { isLessonRead, countsAsSolved, taskProgress } from "@/lib/ui/progress";
import { Segmented } from "../shared/controls";
import { EmptyState } from "../shared/feedback";
import { PageHeader } from "../shared/layout";
import { useCatalog, useData } from "../state/data";
import { useLearner } from "../state/learner";
import { useNav } from "../state/navigation";
import { useTopicStatuses } from "./topicData";

const ROW = 116;
const NODE = 68;
const OFFSETS = [4, 48, 92, 48];

function routePath(count: number): string {
  if (count < 2) return "";
  const x = (i: number) => OFFSETS[i % OFFSETS.length] + NODE / 2;
  const y = (i: number) => i * ROW + ROW / 2;
  let d = `M ${x(0)} ${y(0)}`;
  for (let i = 1; i < count; i++) {
    const midY = (y(i - 1) + y(i)) / 2;
    d += ` C ${x(i - 1)} ${midY}, ${x(i)} ${midY}, ${x(i)} ${y(i)}`;
  }
  return d;
}

function progressText(s: TopicStatus): string {
  const theory = s.lessonsTotal ? `теория ${s.lessonsRead}/${s.lessonsTotal}` : "";
  const practice = s.tasksTotal ? `задачи ${s.solved}/${s.tasksTotal}` : "";
  return [theory, practice].filter(Boolean).join(" · ");
}

function progressLabel(s: TopicStatus): string {
  const theory = s.lessonsTotal ? `Теория: ${s.lessonsRead} из ${s.lessonsTotal}` : "";
  const practice = s.tasksTotal ? `задачи: ${s.solved} из ${s.tasksTotal}` : "";
  return [theory, practice].filter(Boolean).join(", ");
}

export function Stars({
  theory,
  practice,
  size = 16,
}: {
  theory: boolean;
  practice: boolean;
  size?: number;
}) {
  const label = `Звёзды: теория – ${theory ? "получена" : "нет"}, практика – ${practice ? "получена" : "нет"}`;
  return (
    <span className="ol-stars" role="img" aria-label={label}>
      <Star size={size} className={theory ? "is-on" : ""} aria-hidden />
      <Star size={size} className={practice ? "is-on" : ""} aria-hidden />
    </span>
  );
}

export function useOpenTopic() {
  const nav = useNav();
  const catalog = useCatalog();
  const { state } = useData();
  const statusOf = useTopicStatuses();
  return (topic: Pick<Topic, "id">) => {
    haptic.impact("light");
    const status = statusOf(topic.id);
    const part = entryPart(status);
    const items: readonly { id: string }[] =
      part === "theory"
        ? (catalog.lessonsByTopic.get(topic.id) ?? [])
        : (catalog.tasksByTopic.get(topic.id) ?? []);
    const step = firstUnfinished(items, (id) =>
      part === "theory"
        ? isLessonRead(state.progress, id)
        : countsAsSolved(taskProgress(state.progress, id)),
    );
    nav.push({ name: "topic", id: topic.id, part, step });
  };
}

export function LearnHome() {
  const catalog = useCatalog();
  const learner = useLearner();
  const statusOf = useTopicStatuses();
  const openTopic = useOpenTopic();
  const [query, setQuery] = useState("");
  const subject = learner.subject;
  const topics = useMemo(
    () => catalog.topics.filter((t) => t.grade === learner.grade && t.subject === subject),
    [catalog.topics, learner.grade, subject],
  );
  const list = query.trim()
    ? topics.filter((t) => t.title.toLowerCase().includes(query.trim().toLowerCase()))
    : topics;
  const next = recommendedTopic(topics, statusOf);
  const nextStatus = next ? statusOf(next.id) : undefined;
  const earned = topics.reduce(
    (n, t) => n + Number(statusOf(t.id).theoryStar) + Number(statusOf(t.id).practiceStar),
    0,
  );

  return (
    <div className={`ol-screen ol-learn subject-${subject}`}>
      <PageHeader
        title="Учёба"
        subtitle={`${learner.grade} класс · ${plural(topics.length, WORDS.topic)} · ${plural(earned, WORDS.star)} из ${topics.length * 2}`}
      />
      <Segmented
        label="Предмет"
        className="ol-subject-switch"
        value={subject}
        options={[
          { value: "math" as Subject, label: "Математика" },
          { value: "info" as Subject, label: "Информатика" },
        ]}
        onChange={(v) => {
          haptic.selection();
          void learner.update({ subject: v }).catch(() => undefined);
        }}
      />

      {next && nextStatus && !query && (
        <section className="ol-card ol-next-topic" aria-labelledby="next-topic">
          <span className="ol-eyebrow">{nextStatus.started ? "Продолжай" : "Следующая тема"}</span>
          <h2 id="next-topic">{next.title}</h2>
          <p>
            {nextStatus.theoryStar
              ? tasksToStar(nextStatus) > 0
                ? `Теория пройдена. Реши ещё ${plural(tasksToStar(nextStatus), WORDS.problemAcc)} – и получишь вторую звезду`
                : "Осталось закрепить практикой"
              : nextStatus.lessonsTotal
                ? `Начни с теории: ${plural(nextStatus.lessonsTotal, WORDS.lesson)}, потом задачи`
                : "Реши задачи по теме"}
          </p>
          <Button size="large" onClick={() => openTopic(next)}>
            {nextStatus.started ? "Продолжить" : "Начать"}
          </Button>
        </section>
      )}

      <div className="ol-topic-search">
        <Input
          aria-label="Найти тему"
          placeholder="Найти тему"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          iconBefore={<Icon16SearchOutline />}
          withClearButton
        />
      </div>

      {!topics.length ? (
        <EmptyState
          icon={<BookOpen size={32} />}
          title="Темы для этого класса скоро появятся"
          text="Учитель ещё наполняет раздел. Попробуй другой предмет или класс."
        />
      ) : !list.length ? (
        <EmptyState
          icon={<SearchX size={32} />}
          title="Такой темы не нашли"
          text="Проверь, как написано название, или очисти поиск."
          action={
            <Button variant="secondary" onClick={() => setQuery("")}>
              Показать все темы
            </Button>
          }
        />
      ) : (
        <ol className="ol-route" style={{ height: list.length * ROW }} aria-label="Темы по порядку">
          {list.length > 1 && (
            <svg
              className="ol-route-line"
              width={OFFSETS[2] + NODE + 8}
              height={list.length * ROW}
              aria-hidden
            >
              <path className="ol-route-halo" d={routePath(list.length)} />
              <path className="ol-route-path" d={routePath(list.length)} />
            </svg>
          )}
          {list.map((t, i) => {
            const s = statusOf(t.id);
            const isNext = next?.id === t.id;
            const Icon = s.done ? Star : s.theoryStar ? Dumbbell : BookOpen;
            return (
              <li
                key={t.id}
                className={`ol-route-step${s.done ? " is-done" : ""}${isNext ? " is-next" : ""}${s.started ? " is-started" : ""}`}
                style={{ top: i * ROW, paddingLeft: OFFSETS[i % OFFSETS.length] }}
              >
                <button
                  type="button"
                  className="ol-route-btn"
                  onClick={() => openTopic(t)}
                  aria-label={`${t.title}. ${progressLabel(s)}${s.done ? ". Тема пройдена" : isNext ? ". Рекомендуем сейчас" : ""}`}
                >
                  <span className="ol-route-node" aria-hidden>
                    <Icon size={28} />
                  </span>
                  <span className="ol-route-caption">
                    <b>{t.title}</b>
                    <small>
                      <Stars theory={s.theoryStar} practice={s.practiceStar} size={14} />
                      {progressText(s)}
                    </small>
                    {isNext && (
                      <span className="ol-route-next">{s.started ? "Продолжить" : "Начать"}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
