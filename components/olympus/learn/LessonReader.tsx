"use client";
/**
 * Theory of a topic. A lesson counts as read when the child reaches its end (and stays
 * a moment) or presses «Дальше». When every lesson is read the theory star is awarded
 * automatically, with a celebration and the way on to practice.
 */
import { Button } from "@maxhub/max-ui";
import { Check, PartyPopper } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Lesson, Topic } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { haptic } from "@/lib/client/max-bridge";
import { isLessonRead, hasTheoryStar } from "@/lib/ui/progress";
import { Blocks } from "../shared/Blocks";
import { EmptyState } from "../shared/feedback";
import { useData } from "../state/data";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";

const DWELL_MS = 1500;

export function LessonReader({
  topic,
  lessons,
  step,
}: {
  topic: Topic;
  lessons: Lesson[];
  step: number;
}) {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const progress = data.state.progress;
  const index = Math.min(step, Math.max(0, lessons.length - 1));
  const lesson = lessons[index];
  const sentinel = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [starState, setStarState] = useState<"idle" | "claiming" | "celebrate" | "error">("idle");
  const [starError, setStarError] = useState<string | null>(null);
  const starred = hasTheoryStar(progress, topic.id);
  const readCount = lessons.filter((l) => isLessonRead(progress, l.id)).length;
  const allRead = lessons.length > 0 && readCount === lessons.length;
  const unread = lessons
    .map((l, i) => (isLessonRead(progress, l.id) ? -1 : i))
    .filter((i) => i >= 0);

  const markRead = useCallback(
    async (id: string) => {
      try {
        await data.markLessonRead(id);
        setSaveError(null);
      } catch (e) {
        setSaveError(errorMessage(e));
      }
    },
    [data],
  );

  // Reaching the end of the lesson counts as reading it.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !lesson || isLessonRead(progress, lesson.id)) return;
    if (typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) timer = setTimeout(() => void markRead(lesson.id), DWELL_MS);
        else if (timer) clearTimeout(timer);
      },
      { threshold: 1 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [lesson, progress, markRead]);

  const claim = useCallback(async () => {
    setStarState("claiming");
    setStarError(null);
    try {
      await data.claimTheoryStar(topic);
      haptic.success();
      setStarState("celebrate");
      toast.success("Звезда за теорию! ⭐");
    } catch (e) {
      setStarState("error");
      setStarError(errorMessage(e));
    }
  }, [data, topic, toast]);

  // All lessons read → award the theory star automatically.
  useEffect(() => {
    if (!allRead || starred || starState !== "idle") return;
    const t = setTimeout(() => void claim(), 0);
    return () => clearTimeout(t);
  }, [allRead, starred, starState, claim]);

  if (!lesson)
    return (
      <EmptyState
        title="Уроки скоро появятся"
        text="Учитель ещё готовит теорию по этой теме. А пока можно порешать задачи."
        action={
          <Button
            onClick={() => nav.replace({ name: "topic", id: topic.id, part: "practice", step: 0 })}
          >
            К практике
          </Button>
        }
      />
    );

  const go = (i: number) => nav.replace({ name: "topic", id: topic.id, part: "theory", step: i });
  const next = () => {
    void markRead(lesson.id);
    if (index < lessons.length - 1) go(index + 1);
  };
  const last = index === lessons.length - 1;
  const toPractice = () => nav.replace({ name: "topic", id: topic.id, part: "practice", step: 0 });

  return (
    <div className="ol-reader">
      <nav className="ol-stepper" aria-label="Уроки темы">
        {lessons.map((l, i) => {
          const read = isLessonRead(progress, l.id);
          return (
            <button
              key={l.id}
              type="button"
              className={`ol-step${i === index ? " is-current" : ""}${read ? " is-done" : ""}`}
              aria-current={i === index ? "step" : undefined}
              aria-label={`Урок ${i + 1}${read ? ", прочитан" : ""}`}
              onClick={() => go(i)}
            >
              {read ? <Check size={18} aria-hidden /> : i + 1}
            </button>
          );
        })}
      </nav>

      <article className="ol-card ol-lesson" aria-labelledby={`lesson-${lesson.id}`}>
        <span className="ol-eyebrow">
          Урок {index + 1} из {lessons.length}
        </span>
        <h2 id={`lesson-${lesson.id}`}>{lesson.title}</h2>
        <Blocks blocks={lesson.blocks} />
        <div ref={sentinel} className="ol-lesson-end" aria-hidden />
        {saveError && (
          <p className="ol-field-error" role="alert">
            Не получилось отметить урок: {saveError}{" "}
            <button type="button" className="ol-link-btn" onClick={() => void markRead(lesson.id)}>
              Повторить
            </button>
          </p>
        )}
        {starState === "celebrate" || (last && starred && allRead) ? (
          <div className="ol-celebrate" role="status">
            <PartyPopper size={32} aria-hidden />
            <div>
              <b>Теория пройдена!</b>
              <p>Звезда за теорию уже в профиле. Теперь закрепи знания задачами.</p>
            </div>
          </div>
        ) : null}
        {starState === "error" && starError && (
          <p className="ol-field-error" role="alert">
            {starError}{" "}
            <button type="button" className="ol-link-btn" onClick={() => void claim()}>
              Повторить
            </button>
          </p>
        )}
        {last && !allRead && unread.filter((i) => i !== index).length > 0 && (
          <p className="ol-note">
            Чтобы получить звезду, открой{" "}
            {unread
              .filter((i) => i !== index)
              .map((i, k, arr) => (
                <span key={i}>
                  <button type="button" className="ol-link-btn" onClick={() => go(i)}>
                    урок {i + 1}
                  </button>
                  {k < arr.length - 2 ? ", " : k === arr.length - 2 ? " и " : ""}
                </span>
              ))}
            .
          </p>
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
            <Button size="large" onClick={next}>
              Дальше
            </Button>
          ) : starred || starState === "celebrate" ? (
            <Button size="large" onClick={toPractice}>
              К практике
            </Button>
          ) : (
            <Button
              size="large"
              loading={starState === "claiming"}
              onClick={() => void markRead(lesson.id)}
            >
              Завершить теорию
            </Button>
          )}
        </div>
      </article>
    </div>
  );
}
