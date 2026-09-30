"use client";
/** One topic: «Теория» (lessons) → «Практика» (tasks) → two stars. */
import { Button } from "@maxhub/max-ui";
import { useEffect } from "react";
import type { TopicPart } from "@/lib/ui/navigation";
import { plural, WORDS } from "@/lib/ui/plural";
import { SUBJECT_LABEL } from "@/lib/ui/format";
import { Segmented } from "../shared/controls";
import { EmptyState, ErrorBanner, Loading } from "../shared/feedback";
import { PageHeader } from "../shared/layout";
import { useResource } from "../hooks/useResource";
import { useCatalog, useData } from "../state/data";
import { useNav } from "../state/navigation";
import { Stars } from "./LearnHome";
import { LessonReader } from "./LessonReader";
import { PracticeView } from "../training/PracticeView";
import { useTopicStatuses } from "./topicData";

export function TopicScreen({ id, part, step }: { id: string; part: TopicPart; step: number }) {
  const catalog = useCatalog();
  const data = useData();
  const nav = useNav();
  const statusOf = useTopicStatuses();
  const topic = catalog.topics.find((t) => t.id === id);
  const cached = data.state.topics[id] ?? null;
  const resource = useResource(() => data.loadTopic(id), { initial: cached, skip: !!cached });
  const content = cached ?? resource.data;

  useEffect(() => {
    data.rememberTopic({ id, part, step });
  }, [data, id, part, step]);

  if (!topic)
    return (
      <div className="ol-screen">
        <PageHeader title="Тема не найдена" back="Учёба" />
        <EmptyState
          title="Этой темы больше нет"
          text="Возможно, её переименовали или убрали. Выбери тему из списка."
          action={<Button onClick={() => nav.go("learn")}>К темам</Button>}
        />
      </div>
    );

  const status = statusOf(id);
  const setPart = (next: TopicPart) => nav.replace({ name: "topic", id, part: next, step: 0 });

  return (
    <div className={`ol-screen ol-topic subject-${topic.subject}`}>
      <PageHeader
        back="Все темы"
        eyebrow={`${SUBJECT_LABEL[topic.subject]} · ${topic.grade} класс`}
        title={topic.title}
        aside={<Stars theory={status.theoryStar} practice={status.practiceStar} size={22} />}
      />
      <Segmented
        label="Раздел темы"
        className="ol-topic-parts"
        value={part}
        onChange={setPart}
        options={[
          {
            value: "theory" as TopicPart,
            label: (
              <>
                Теория{" "}
                <small>
                  {status.lessonsRead}/{status.lessonsTotal}
                </small>
              </>
            ),
            aria: `Теория: прочитано ${status.lessonsRead} из ${plural(status.lessonsTotal, WORDS.lessonGen)}`,
          },
          {
            value: "practice" as TopicPart,
            label: (
              <>
                Практика{" "}
                <small>
                  {status.solved}/{status.tasksTotal}
                </small>
              </>
            ),
            aria: `Практика: решено ${status.solved} из ${plural(status.tasksTotal, WORDS.taskGen)}`,
          },
        ]}
      />
      {resource.loading && !content ? (
        <Loading label="Открываем тему…" />
      ) : resource.error && !content ? (
        <ErrorBanner
          title="Не получилось открыть тему"
          message={resource.error}
          onRetry={resource.retry}
          action={
            resource.errorAction === "back" ? (
              <Button size="small" variant="secondary" onClick={() => nav.go("learn")}>
                К темам
              </Button>
            ) : undefined
          }
        />
      ) : content ? (
        part === "theory" ? (
          <LessonReader topic={topic} lessons={content.lessons} step={step} />
        ) : (
          <PracticeView topic={topic} tasks={content.tasks} step={step} />
        )
      ) : null}
    </div>
  );
}
