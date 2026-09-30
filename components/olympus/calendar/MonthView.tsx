"use client";
/**
 * Month grid: olympiad days (blue), last days of registration (orange ring) and the
 * child's olympiads (green). Changing filters never moves the month.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { CalendarEntry, DayMarks } from "@/lib/ui/calendar";
import { dayIndex, initialMonth } from "@/lib/ui/calendar";
import { addMonths, formatDay, formatMonth, monthGrid, WEEKDAYS_SHORT } from "@/lib/ui/dates";
import { plural, WORDS } from "@/lib/ui/plural";

export function MonthView({
  entries,
  today,
  isRegistered,
  onOpen,
  hasSeries,
}: {
  entries: CalendarEntry[];
  today: string;
  isRegistered(id: string): boolean;
  onOpen(id: string): void;
  hasSeries: boolean;
}) {
  // The month is chosen once, from the first data we see – filters don't move it.
  const [cursor, setCursor] = useState(() => initialMonth(entries, today));
  const [selected, setSelected] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const index = useMemo(() => dayIndex(entries), [entries]);
  const cells = monthGrid(cursor.year, cursor.month);
  const monthKey = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}`;
  const inMonth = [...index.keys()].filter((d) => d.startsWith(monthKey));
  const nextDay = [...index.keys()].filter((d) => d > `${monthKey}-31` && d >= today).sort()[0];
  const picked: DayMarks | undefined = selected ? index.get(selected) : undefined;
  const year = Number(today.slice(0, 4));

  const move = (delta: number) => {
    setCursor((c) => addMonths(c.year, c.month, delta));
    setSelected(null);
  };

  const pickDay = (iso: string) => {
    const marks = index.get(iso);
    if (!marks) return;
    const all = [...marks.events, ...marks.deadlines];
    if (all.length === 1) return onOpen(all[0].event.id);
    setSelected(iso);
    requestAnimationFrame(() =>
      panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }),
    );
  };

  return (
    <section className="ol-month" aria-label="Календарь на месяц">
      <div className="ol-month-head">
        <button
          type="button"
          className="ol-icon-btn"
          aria-label="Предыдущий месяц"
          onClick={() => move(-1)}
        >
          <ChevronLeft size={22} aria-hidden />
        </button>
        <h3 aria-live="polite">{formatMonth(cursor.year, cursor.month)}</h3>
        <button
          type="button"
          className="ol-icon-btn"
          aria-label="Следующий месяц"
          onClick={() => move(1)}
        >
          <ChevronRight size={22} aria-hidden />
        </button>
      </div>
      <div className="ol-month-grid">
        <div className="ol-month-weekdays" aria-hidden>
          {WEEKDAYS_SHORT.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="ol-month-days">
          {cells.map((c, i) => {
            if (!c.iso) return <span key={`b${i}`} aria-hidden className="ol-day is-blank" />;
            const marks = index.get(c.iso);
            const events = marks?.events.length ?? 0;
            const deadlines = marks?.deadlines.length ?? 0;
            const mine =
              !!marks &&
              [...marks.events, ...marks.deadlines].some((e) => isRegistered(e.event.id));
            const label = [
              formatDay(c.iso, year),
              events ? plural(events, WORDS.olympiad) : "",
              deadlines ? `последний день регистрации: ${deadlines}` : "",
              mine ? "есть твоя олимпиада" : "",
            ]
              .filter(Boolean)
              .join(", ");
            const cls = [
              "ol-day",
              events ? "has-event" : "",
              deadlines ? "has-deadline" : "",
              mine ? "is-mine" : "",
              c.iso === today ? "is-today" : "",
              c.iso === selected ? "is-selected" : "",
              c.iso < today ? "is-past" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={c.iso}
                type="button"
                className={cls}
                disabled={!marks}
                aria-label={label}
                aria-current={c.iso === today ? "date" : undefined}
                onClick={() => pickDay(c.iso as string)}
              >
                {c.day}
              </button>
            );
          })}
        </div>
      </div>
      {!inMonth.length && (
        <p className="ol-month-empty">
          В этом месяце олимпиад нет.
          {nextDay && (
            <>
              {" "}
              <button
                type="button"
                className="ol-link-btn"
                onClick={() => {
                  const [y, m] = nextDay.split("-").map(Number);
                  setCursor({ year: y, month: m - 1 });
                }}
              >
                Ближайшая – {formatDay(nextDay, year)} →
              </button>
            </>
          )}
        </p>
      )}
      <div className="ol-month-legend">
        <span>
          <i className="ol-dot ol-dot--event" aria-hidden /> Олимпиада
        </span>
        <span>
          <i className="ol-dot ol-dot--deadline" aria-hidden /> Последний день регистрации
        </span>
        <span>
          <i className="ol-dot ol-dot--mine" aria-hidden /> Ты участвуешь
        </span>
      </div>
      {hasSeries && (
        <p className="ol-month-note">
          У олимпиад с датами по регионам (например, ВсОШ) дни появятся здесь, когда ты выберешь
          регион.
        </p>
      )}
      {picked && selected && (
        <div className="ol-day-panel" ref={panelRef} aria-live="polite">
          <h4>{formatDay(selected, year)}</h4>
          <ul>
            {picked.events.map((e) => (
              <li key={`e-${e.key}`}>
                <button type="button" onClick={() => onOpen(e.event.id)}>
                  <span>{e.event.title}</span>
                  <small>Олимпиада</small>
                </button>
              </li>
            ))}
            {picked.deadlines.map((e) => (
              <li key={`d-${e.key}`}>
                <button type="button" onClick={() => onOpen(e.event.id)}>
                  <span>{e.event.title}</span>
                  <small>Последний день регистрации</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
