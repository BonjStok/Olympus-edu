"use client";
/** Olympiad list cards: one olympiad, a collapsed series of regional editions, a family of series. */
import { CalendarDays, Check, ChevronRight, MapPin, Wallet } from "lucide-react";
import { useId } from "react";
import type { EventEntry, ListItem, SeriesEntry, SeriesFamily } from "@/lib/ui/calendar";
import { eventDateLabel, placeLabel, registrationLine, seriesLine } from "@/lib/ui/calendar-labels";
import { gradesLabel, priceLabel, subjectsLabel, SUBJECT_LABEL } from "@/lib/ui/format";
import { plural, WORDS } from "@/lib/ui/plural";

export function DemoBadge() {
  return (
    <span className="ol-badge ol-badge--demo" title="Учебный пример, а не настоящая олимпиада">
      Пример
    </span>
  );
}

export function RegisteredBadge() {
  return (
    <span className="ol-badge ol-badge--ok">
      <Check size={14} aria-hidden /> Ты участвуешь
    </span>
  );
}

export function EventCard({
  entry,
  registered,
  year,
  onOpen,
}: {
  entry: EventEntry;
  registered: boolean;
  year: number;
  onOpen(): void;
}) {
  const e = entry.event;
  const status = registrationLine(e, entry.timing, year);
  const price = priceLabel(e.price);
  const id = useId();
  return (
    <article
      className={`ol-event-card subject-${e.subject}${e.featured ? " is-featured" : ""}${entry.timing.past ? " is-past" : ""}`}
    >
      <button
        type="button"
        className="ol-event-card-btn"
        onClick={onOpen}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-badges ${id}-status ${id}-meta ${id}-subject`}
      >
        <span className="ol-event-card-top">
          <span className="ol-event-subject" id={`${id}-subject`}>
            {subjectsLabel(e)} · {gradesLabel(e.grades)}
          </span>
          <span className="ol-event-badges" id={`${id}-badges`}>
            {e.featured && <span className="ol-badge ol-badge--max">Рекомендуем</span>}
            {e.demo && <DemoBadge />}
            {registered && <RegisteredBadge />}
          </span>
        </span>
        <span className="ol-event-title" id={`${id}-title`}>
          {e.title}
        </span>
        {e.stage && <span className="ol-event-stage">{e.stage}</span>}
        <span className={`ol-status ol-status--${status.tone}`} id={`${id}-status`}>
          {status.text}
        </span>
        <span className="ol-event-meta" id={`${id}-meta`}>
          <span>
            <CalendarDays size={16} aria-hidden />
            {eventDateLabel(e, year, true)}
          </span>
          <span>
            <MapPin size={16} aria-hidden />
            {placeLabel(e)}
          </span>
          {price && (
            <span>
              <Wallet size={16} aria-hidden />
              {price}
            </span>
          )}
        </span>
        <ChevronRight size={20} aria-hidden className="ol-event-chevron" />
      </button>
    </article>
  );
}

export function SeriesCard({ entry, onPickRegion }: { entry: SeriesEntry; onPickRegion(): void }) {
  return (
    <article className={`ol-event-card ol-series-card subject-${entry.subject}`}>
      <div className="ol-event-card-body">
        <span className="ol-event-card-top">
          <span className="ol-event-subject">
            {SUBJECT_LABEL[entry.subject]} · {gradesLabel(entry.grades)}
          </span>
          {entry.demo && <DemoBadge />}
        </span>
        <h3 className="ol-event-title">{entry.title}</h3>
        <span className="ol-status ol-status--info">{seriesLine(entry)}</span>
        <p className="ol-series-note">Выбери регион, чтобы увидеть дату и как участвовать.</p>
        <button type="button" className="ol-series-cta" onClick={onPickRegion}>
          <MapPin size={18} aria-hidden />
          Выбрать регион
        </button>
      </div>
    </article>
  );
}

export function FamilyCard({
  family,
  onPickRegion,
}: {
  family: SeriesFamily;
  onPickRegion(): void;
}) {
  const grades = [...new Set(family.members.flatMap((m) => m.entry.grades))];
  const profiles = family.members.filter((m) => m.profile !== "без профилей").length;
  return (
    <article className={`ol-event-card ol-series-card subject-${family.subject}`}>
      <div className="ol-event-card-body">
        <span className="ol-event-card-top">
          <span className="ol-event-subject">
            {SUBJECT_LABEL[family.subject]} · {gradesLabel(grades)}
          </span>
        </span>
        <h3 className="ol-event-title">{family.title}</h3>
        <span className="ol-status ol-status--info">
          {[
            family.stage,
            `${plural(profiles, ["профиль", "профиля", "профилей"])} – участвовать можно в одном`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <ul className="ol-family-list">
          {family.members.map((m) => (
            <li key={m.entry.key}>
              <b>{m.profile.charAt(0).toUpperCase() + m.profile.slice(1)}</b>
              <small>в {plural(m.entry.regionCount, WORDS.regionPrep)}</small>
            </li>
          ))}
        </ul>
        <p className="ol-series-note">
          Даты зависят от региона. Выбери регион – покажем твои даты.
        </p>
        <button type="button" className="ol-series-cta" onClick={onPickRegion}>
          <MapPin size={18} aria-hidden />
          Выбрать регион
        </button>
      </div>
    </article>
  );
}

export function EntryCard({
  item,
  registered,
  year,
  onOpen,
  onPickRegion,
}: {
  item: ListItem;
  registered: (id: string) => boolean;
  year: number;
  onOpen(id: string): void;
  onPickRegion(): void;
}) {
  if (item.kind === "family") return <FamilyCard family={item} onPickRegion={onPickRegion} />;
  if (item.kind === "series") return <SeriesCard entry={item} onPickRegion={onPickRegion} />;
  return (
    <EventCard
      entry={item}
      registered={registered(item.event.id)}
      year={year}
      onOpen={() => onOpen(item.event.id)}
    />
  );
}
