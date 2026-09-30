"use client";
import { useMemo } from "react";
import { topicStatus, type TopicStatus } from "@/lib/ui/learning";
import { useCatalog, useData } from "../state/data";

const EMPTY: TopicStatus = {
  lessonsRead: 0,
  lessonsTotal: 0,
  solved: 0,
  tasksTotal: 0,
  theoryStar: false,
  practiceStar: false,
  started: false,
  done: false,
};

/** Progress of every topic for the current progress map. */
export function useTopicStatuses(): (topicId: string) => TopicStatus {
  const catalog = useCatalog();
  const { state } = useData();
  const statuses = useMemo(() => {
    const map = new Map<string, TopicStatus>();
    for (const t of catalog.topics)
      map.set(
        t.id,
        topicStatus(
          t.id,
          catalog.lessonsByTopic.get(t.id) ?? [],
          catalog.tasksByTopic.get(t.id) ?? [],
          state.progress,
        ),
      );
    return map;
  }, [catalog, state.progress]);
  return (id: string) => statuses.get(id) ?? EMPTY;
}
