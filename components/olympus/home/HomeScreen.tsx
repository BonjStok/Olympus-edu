"use client";
/**
 * «Главная»: continue where you stopped, the nearest olympiad for your class and region,
 * your olympiads and progress – the shortest path to the next useful action.
 */
import { Button, CellList, CellSimple } from "@maxhub/max-ui";
import {
  CalendarDays,
  ChevronRight,
  MessageCircle,
  Star,
  Trophy,
  CheckCircle2,
  MapPin,
} from "lucide-react";
import { useMemo } from "react";
import type { Topic } from "@/lib/domain/types";
import { localStore } from "@/lib/client/storage";
import { isInsideMax } from "@/lib/client/max-bridge";
import { nextOpenEntry, registeredEvents } from "@/lib/ui/calendar";
import { eventDateLabel, placeLabel, registrationLine, seriesLine } from "@/lib/ui/calendar-labels";
import { todayIso } from "@/lib/ui/dates";
import { recommendedTopic } from "@/lib/ui/learning";
import { pluralForm, WORDS } from "@/lib/ui/plural";
import { medalCount, solvedCount, starCount } from "@/lib/ui/progress";
import { SUBJECT_LABEL } from "@/lib/ui/format";
import { PageHeader, SectionTitle } from "../shared/layout";
import { useCatalog, useData, LAST_TOPIC_KEY, type LastTopic } from "../state/data";
import { setIntent } from "../state/intent";
import { useLearner } from "../state/learner";
import { useNav } from "../state/navigation";
import { Stars, useOpenTopic } from "../learn/LearnHome";
import { useTopicStatuses } from "../learn/topicData";

export function HomeScreen() {
  const { state } = useData();
  const catalog = useCatalog();
  const learner = useLearner();
  const nav = useNav();
  const statusOf = useTopicStatuses();
  const openTopic = useOpenTopic();
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const name = state.profile.name;

  const last = localStore.getJSON<LastTopic>(LAST_TOPIC_KEY);
  const lastTopic = last ? catalog.topics.find((t) => t.id === last.id) : undefined;
  const pathTopics = useMemo(
    () => catalog.topics.filter((t) => t.grade === learner.grade && t.subject === learner.subject),
    [catalog.topics, learner.grade, learner.subject],
  );
  const recommended = recommendedTopic(pathTopics, statusOf);
  const continueTopic: Topic | undefined =
    lastTopic && !statusOf(lastTopic.id).done ? lastTopic : recommended;
  const continueStatus = continueTopic ? statusOf(continueTopic.id) : undefined;

  const next = useMemo(
    () => nextOpenEntry(catalog.olympiads, learner.calendarDefaults, today),
    [catalog.olympiads, learner.calendarDefaults, today],
  );
  const mine = registeredEvents(catalog.olympiads, state.progress, today).filter(
    (r) => !r.timing.past,
  );
  const stars = starCount(state.progress);
  const solved = solvedCount(state.progress);
  const medals = medalCount(state.progress);

  return (
    <div className="ol-screen ol-home">
      <PageHeader
        title={name ? `Привет, ${name}!` : "Привет!"}
        subtitle="Готовимся к олимпиадам по математике и информатике"
      />

      {continueTopic && continueStatus && (
        <section
          className={`ol-card ol-continue subject-${continueTopic.subject}`}
          aria-labelledby="home-continue"
        >
          <span className="ol-eyebrow">
            {continueStatus.started ? "Продолжить" : "Начни с темы"} ·{" "}
            {SUBJECT_LABEL[continueTopic.subject]}
          </span>
          <h2 id="home-continue">{continueTopic.title}</h2>
          <p className="ol-continue-progress">
            <Stars theory={continueStatus.theoryStar} practice={continueStatus.practiceStar} />
            Теория {continueStatus.lessonsRead} из {continueStatus.lessonsTotal} · задачи{" "}
            {continueStatus.solved} из {continueStatus.tasksTotal}
          </p>
          <Button size="large" onClick={() => openTopic(continueTopic)}>
            {continueStatus.started ? "Продолжить" : "Начать"}
          </Button>
        </section>
      )}

      <section aria-labelledby="home-olympiad">
        <SectionTitle id="home-olympiad">Ближайшая олимпиада</SectionTitle>
        {next ? (
          <button
            type="button"
            className="ol-card ol-home-event"
            onClick={() =>
              next.kind === "event"
                ? nav.reset({ tab: "calendar", stack: [{ name: "event", id: next.event.id }] })
                : (setIntent({ type: "pick-region" }), nav.go("calendar"))
            }
          >
            <CalendarDays size={28} aria-hidden className="ol-home-event-icon" />
            <span className="ol-home-event-text">
              <b>{next.kind === "event" ? next.event.title : next.title}</b>
              {next.kind === "event" ? (
                <>
                  <span
                    className={`ol-status ol-status--${registrationLine(next.event, next.timing, year).tone}`}
                  >
                    {registrationLine(next.event, next.timing, year).text}
                  </span>
                  <small>
                    {eventDateLabel(next.event, year)} · {placeLabel(next.event)}
                  </small>
                </>
              ) : (
                <>
                  <span className="ol-status ol-status--info">{seriesLine(next)}</span>
                  <small>Выбери регион, чтобы увидеть свои даты</small>
                </>
              )}
            </span>
            <ChevronRight size={20} aria-hidden />
          </button>
        ) : (
          <p className="ol-note">
            Открытых регистраций для твоего класса сейчас нет – загляни позже.
          </p>
        )}
        {!learner.region && (
          <button
            type="button"
            className="ol-link-btn ol-home-region"
            onClick={() => {
              setIntent({ type: "pick-region" });
              nav.go("calendar");
            }}
          >
            <MapPin size={16} aria-hidden /> Выбери регион – покажем и региональные олимпиады
          </button>
        )}
        <Button variant="secondary" size="medium" onClick={() => nav.go("calendar")}>
          Все олимпиады
        </Button>
      </section>

      {mine.length > 0 && (
        <section aria-labelledby="home-mine">
          <SectionTitle id="home-mine" count={mine.length}>
            Мои олимпиады
          </SectionTitle>
          <CellList mode="island">
            {mine.slice(0, 3).map(({ event, timing }) => (
              <CellSimple
                key={event.id}
                as="button"
                showChevron
                title={event.title}
                subtitle={`${eventDateLabel(event, year)} · ${registrationLine(event, timing, year).text}`}
                before={<CheckCircle2 size={22} aria-hidden className="ol-icon-ok" />}
                onClick={() =>
                  nav.reset({ tab: "calendar", stack: [{ name: "event", id: event.id }] })
                }
              />
            ))}
          </CellList>
        </section>
      )}

      <section aria-labelledby="home-progress">
        <SectionTitle id="home-progress">Мой прогресс</SectionTitle>
        <button type="button" className="ol-card ol-home-stats" onClick={() => nav.go("profile")}>
          <span>
            <Star size={22} aria-hidden />
            <b>{stars}</b>
            <small>{pluralForm(stars, WORDS.star)}</small>
          </span>
          <span>
            <CheckCircle2 size={22} aria-hidden />
            <b>{solved}</b>
            <small>{pluralForm(solved, WORDS.solvedProblem)}</small>
          </span>
          <span>
            <Trophy size={22} aria-hidden />
            <b>{medals}</b>
            <small>{pluralForm(medals, WORDS.medal)}</small>
          </span>
        </button>
      </section>

      <aside className="ol-bot-hint">
        <MessageCircle size={20} aria-hidden />
        <p>
          {isInsideMax()
            ? "Бот Олимпуса в MAX подскажет ближайшие олимпиады – напиши ему «/calendar»."
            : "Олимпус работает в MAX: бот подскажет ближайшие олимпиады, а прогресс сохранится на всех устройствах."}
          {state.features.reminders && " Он же напомнит о сроках регистрации."}
        </p>
      </aside>
    </div>
  );
}
