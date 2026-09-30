"use client";
/**
 * «Олимпиады»: filters that follow the child's context, a list split into
 * «Можно зарегистрироваться» / «Скоро» / «Даты уточняются» / collapsed closed and past,
 * and the month grid as a secondary view.
 */
import { Button, Counter } from "@maxhub/max-ui";
import { CalendarSearch, ChevronDown, List, CalendarDays, SlidersHorizontal } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Grade, Subject } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import {
  buildCalendar,
  COLLAPSED_SECTIONS,
  describeFilters,
  groupFamilies,
  isRegistered,
  type CalendarFilters,
  type FormatFilter,
  type SectionId,
} from "@/lib/ui/calendar";
import { todayIso } from "@/lib/ui/dates";
import { plural, WORDS } from "@/lib/ui/plural";
import { Segmented, Select } from "../shared/controls";
import { EmptyState } from "../shared/feedback";
import { PageHeader } from "../shared/layout";
import { RegionCombobox } from "../shared/RegionCombobox";
import { useCatalog, useData } from "../state/data";
import { takeIntent, useIntent } from "../state/intent";
import { useLearner } from "../state/learner";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { EntryCard } from "./EventCard";
import { MonthView } from "./MonthView";

const GRADE_OPTS = [
  { value: "all", label: "Все классы" },
  { value: "4", label: "4 класс" },
  { value: "5", label: "5 класс" },
  { value: "6", label: "6 класс" },
] as const;

const SUBJECT_OPTS = [
  { value: "all", label: "Все предметы" },
  { value: "math", label: "Математика" },
  { value: "info", label: "Информатика" },
] as const;

const FORMAT_OPTS = [
  { value: "all", label: "Онлайн и очно" },
  { value: "online", label: "Только онлайн" },
  { value: "offline", label: "Только очно" },
] as const;

const REGION_PROMPT_KEY = "olympus.regionPromptDismissed";
/** Cards in the very first paint of the tab; the rest follow without blocking the tap. */
const FIRST_PAINT_CARDS = 6;

function useRegionPromptDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(REGION_PROMPT_KEY) === "1";
    } catch {
      return false;
    }
  });
  return [
    dismissed,
    () => {
      setDismissed(true);
      try {
        localStorage.setItem(REGION_PROMPT_KEY, "1");
      } catch {
        /* private mode: remember for this visit only */
      }
    },
  ];
}

export function CalendarScreen() {
  const { state } = useData();
  const catalog = useCatalog();
  const learner = useLearner();
  const nav = useNav();
  const toast = useToast();
  const intent = useIntent();
  const regionId = useId();
  const regionBoxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"list" | "month">("list");
  // «Выбрать регион» from another screen arrives as an intent: open the filters right away.
  const [regionRequested] = useState(() => intent?.type === "pick-region");
  const [filtersOpen, setFiltersOpen] = useState(
    () =>
      regionRequested ||
      (typeof window !== "undefined" && !!window.matchMedia?.("(min-width: 900px)").matches),
  );
  const [openSections, setOpenSections] = useState<SectionId[]>([]);
  const [promptDismissed, dismissPrompt] = useRegionPromptDismissed();
  // Filters start from the child's context; subject and format are local to this screen.
  const [local, setLocal] = useState<Pick<CalendarFilters, "subject" | "format">>(() => ({
    subject: learner.calendarDefaults.subject,
    format: "all",
  }));
  const [gradeFilter, setGradeFilter] = useState<Grade | "all">(learner.calendarDefaults.grade);
  const filters: CalendarFilters = {
    grade: gradeFilter,
    subject: local.subject,
    format: local.format,
    region: learner.region,
  };
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const view$ = useMemo(
    () => buildCalendar(catalog.olympiads, filters, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog.olympiads, filters.grade, filters.subject, filters.format, filters.region, today],
  );
  // Hundreds of olympiads: paint the top of the list at once, render the rest right after as
  // a background (interruptible) update, so opening the tab stays instant on slow phones.
  const complete = useDeferredValue(true, false);
  const items = useMemo(
    () => view$.sections.map((section) => groupFamilies(section.entries)),
    [view$],
  );
  let budget = complete ? Infinity : FIRST_PAINT_CARDS;
  const registered = (id: string) => isRegistered(state.progress, id);
  const hasSeries = view$.entries.some((e) => e.kind === "series");
  const changed =
    gradeFilter !== learner.calendarDefaults.grade ||
    local.subject !== learner.calendarDefaults.subject ||
    local.format !== "all";

  const setRegion = (region: string) => {
    learner.update({ region }).catch((e) => toast.error(errorMessage(e)));
    if (region) dismissPrompt();
  };

  const focusRegion = () =>
    requestAnimationFrame(() => {
      regionBoxRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      regionBoxRef.current?.querySelector("input")?.focus();
    });

  const pickRegion = () => {
    setFiltersOpen(true);
    focusRegion();
  };

  useEffect(() => {
    if (!regionRequested) return;
    takeIntent("pick-region");
    focusRegion();
  }, [regionRequested]);

  const openEvent = (id: string) => nav.push({ name: "event", id });
  const toggleSection = (id: SectionId) =>
    setOpenSections((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const showRegionPrompt = !learner.region && !promptDismissed;
  const openCount = view$.sections.find((s) => s.id === "open")?.entries.length ?? 0;

  return (
    <div className="ol-screen ol-calendar">
      <PageHeader
        title="Олимпиады"
        subtitle={`Показаны: ${describeFilters(filters)}`}
        aside={
          <Segmented
            label="Вид"
            size="small"
            value={view}
            onChange={(v) => setView(v)}
            options={[
              { value: "list" as const, label: <List size={18} aria-hidden />, aria: "Списком" },
              {
                value: "month" as const,
                label: <CalendarDays size={18} aria-hidden />,
                aria: "Календарём",
              },
            ]}
          />
        }
      />

      {showRegionPrompt && (
        <section className="ol-card ol-region-prompt" aria-labelledby={`${regionId}-prompt`}>
          <h2 id={`${regionId}-prompt`}>Где ты учишься?</h2>
          <p>
            Выбери регион – покажем олимпиады, которые проходят у тебя, и всероссийские. Выбор
            запомним.
          </p>
          <RegionCombobox
            label="Твой регион"
            value={learner.region}
            onChange={setRegion}
            placeholder="Начни вводить регион"
          />
          <Button variant="ghost" size="small" onClick={dismissPrompt}>
            Не сейчас
          </Button>
        </section>
      )}

      <section className="ol-card ol-filters" aria-label="Фильтры">
        <div className="ol-filters-summary">
          <button
            type="button"
            className="ol-filters-toggle"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <SlidersHorizontal size={18} aria-hidden />
            Фильтры
            <ChevronDown size={18} aria-hidden className="ol-filters-chevron" />
          </button>
          {changed && (
            <button
              type="button"
              className="ol-link-btn"
              onClick={() => {
                setGradeFilter(learner.calendarDefaults.grade);
                setLocal({ subject: learner.calendarDefaults.subject, format: "all" });
              }}
            >
              Сбросить
            </button>
          )}
        </div>
        <div className="ol-filters-grid" hidden={!filtersOpen}>
          <label className="ol-field">
            <span className="ol-field-label">Класс</span>
            <Select
              label="Класс"
              value={String(gradeFilter)}
              options={GRADE_OPTS}
              onChange={(v) => {
                const g = v === "all" ? "all" : (Number(v) as Grade);
                setGradeFilter(g);
                if (g !== "all") learner.update({ grade: g }).catch(() => undefined);
              }}
            />
          </label>
          <label className="ol-field">
            <span className="ol-field-label">Предмет</span>
            <Select
              label="Предмет"
              value={local.subject}
              options={SUBJECT_OPTS}
              onChange={(v) => setLocal((l) => ({ ...l, subject: v as Subject | "all" }))}
            />
          </label>
          <div className="ol-field" ref={regionBoxRef}>
            <span className="ol-field-label" id={regionId}>
              Регион
            </span>
            <RegionCombobox
              label="Регион"
              labelledBy={regionId}
              value={learner.region}
              onChange={setRegion}
              placeholder="Все регионы · начни вводить"
              emptyOptionLabel="Все регионы"
            />
          </div>
          <label className="ol-field">
            <span className="ol-field-label">Как проходит</span>
            <Select
              label="Как проходит"
              value={local.format}
              options={FORMAT_OPTS}
              onChange={(v) => setLocal((l) => ({ ...l, format: v as FormatFilter }))}
            />
          </label>
          <p className="ol-filters-note">
            {learner.region
              ? `Показываем олимпиады для всей России и для региона «${learner.region}» – онлайн и очные.`
              : "Регион не выбран: региональные олимпиады собраны в одну карточку на все регионы."}
          </p>
        </div>
      </section>

      {view === "month" ? (
        <MonthView
          entries={view$.entries}
          today={today}
          isRegistered={registered}
          onOpen={openEvent}
          hasSeries={hasSeries}
        />
      ) : null}

      {view$.sections.length === 0 ? (
        <EmptyState
          icon={<CalendarSearch size={32} />}
          title="Таких олимпиад пока нет"
          text={
            learner.region
              ? `Для «${describeFilters(filters)}» ничего не нашли. Попробуй другой класс или предмет.`
              : "Попробуй изменить фильтры."
          }
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setGradeFilter("all");
                setLocal({ subject: "all", format: "all" });
              }}
            >
              Показать все олимпиады
            </Button>
          }
        />
      ) : (
        view$.sections.map((section, index) => {
          const collapsible = COLLAPSED_SECTIONS.includes(section.id);
          const open = !collapsible || openSections.includes(section.id);
          const headingId = `${regionId}-${section.id}`;
          const list = open ? items[index].slice(0, Math.max(0, budget)) : [];
          budget -= list.length;
          if (!complete && !list.length) return null;
          return (
            <section
              key={section.id}
              className={`ol-cal-section ol-cal-section--${section.id}`}
              aria-labelledby={headingId}
            >
              {collapsible ? (
                <h2 id={headingId} className="ol-cal-section-title">
                  <button
                    type="button"
                    className="ol-collapse-btn"
                    aria-expanded={open}
                    onClick={() => toggleSection(section.id)}
                  >
                    {section.title}
                    <span className="ol-count">{section.entries.length}</span>
                    <span className="ol-collapse-hint">{open ? "Скрыть" : "Показать"}</span>
                    <ChevronDown size={18} aria-hidden />
                  </button>
                </h2>
              ) : (
                <h2 id={headingId} className="ol-cal-section-title">
                  {section.title}
                  <Counter
                    value={section.entries.length}
                    variant="primary"
                    rounded
                    className="ol-counter"
                    aria-label={plural(section.entries.length, WORDS.olympiad)}
                  />
                </h2>
              )}
              {open && (
                <div className="ol-event-list">
                  {list.map((item) => (
                    <EntryCard
                      key={item.key}
                      item={item}
                      registered={registered}
                      year={year}
                      onOpen={openEvent}
                      onPickRegion={pickRegion}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}

      {complete && openCount > 0 && (
        <aside className="ol-callout">
          <div>
            <h3>До олимпиады есть время подготовиться</h3>
            <p>Разбери теорию и реши задачи по своей теме.</p>
          </div>
          <Button variant="primary" onClick={() => nav.go("learn")}>
            К учёбе
          </Button>
        </aside>
      )}
    </div>
  );
}
