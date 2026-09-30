"use client";
/** «Пробники»: mock tests for the child's class, best result, resume a running attempt. */
import { Button } from "@maxhub/max-ui";
import { ClipboardCheck, Clock, ListChecks, Shuffle, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Grade, MockTest, Subject } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { haptic } from "@/lib/client/max-bridge";
import { formatCountdown } from "@/lib/ui/dates";
import { mockTitle } from "@/lib/ui/mocks";
import { plural, WORDS } from "@/lib/ui/plural";
import { activeAttempt, attemptsForTest, bestResult, mockTaskCount } from "@/lib/ui/progress";
import { Select } from "../shared/controls";
import { Dialog } from "../shared/Dialog";
import { EmptyState } from "../shared/feedback";
import { PageHeader } from "../shared/layout";
import { useCountdown } from "../hooks/useCountdown";
import { useNow } from "../hooks/useNow";
import { useCatalog, useData } from "../state/data";
import { takeIntent, useIntent } from "../state/intent";
import { useLearner } from "../state/learner";
import { useNav } from "../state/navigation";

export function StartMockDialog({
  test,
  onOpenChange,
}: {
  test: MockTest | null;
  onOpenChange(open: boolean): void;
}) {
  const data = useData();
  const nav = useNav();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = test ? mockTaskCount(test) : 0;

  const start = async () => {
    if (!test) return;
    setPending(true);
    setError(null);
    try {
      const attempt = await data.startMock(test);
      haptic.impact("medium");
      onOpenChange(false);
      nav.push({ name: "attempt", id: attempt.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={!!test}
      onOpenChange={(v) => {
        if (!v) setError(null);
        onOpenChange(v);
      }}
      title="Готов к пробнику?"
      description={test ? mockTitle(test) : undefined}
      busy={pending}
      footer={
        <>
          <Button
            size="large"
            variant="secondary"
            stretched
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Позже
          </Button>
          <Button size="large" stretched loading={pending} onClick={() => void start()}>
            Начать
          </Button>
        </>
      }
    >
      {test && (
        <ul className="ol-rules">
          <li>
            <ListChecks size={20} aria-hidden /> {plural(count, WORDS.task)} ·{" "}
            {plural(test.minutes, WORDS.minute)}
          </li>
          <li>
            <Clock size={20} aria-hidden /> Таймер не остановится, даже если закрыть приложение
          </li>
          <li>
            <Trophy size={20} aria-hidden /> Ответы и разборы откроются сразу после финиша
          </li>
        </ul>
      )}
      {error && (
        <p className="ol-field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** «Идёт попытка · осталось 42:10», ticking every second by the server clock. */
function TimeLeft({ ends }: { ends: number }) {
  const left = useCountdown(ends);
  if (left <= 0) return <>Время вышло – ответы сохранены, осталось узнать результат</>;
  return <>Идёт попытка · осталось {formatCountdown(left)}</>;
}

export function MocksScreen() {
  const catalog = useCatalog();
  const { state } = useData();
  const learner = useLearner();
  const nav = useNav();
  const intent = useIntent();
  const now = useNow();
  const [grade, setGrade] = useState<Grade | "all">(learner.grade);
  const [subject, setSubject] = useState<Subject | "all">(
    learner.bothSubjects ? "all" : learner.subject,
  );
  const [olympiad, setOlympiad] = useState("all");
  // A deep link «mock_<id>» arrives as an intent: open that mock right away.
  const [requested] = useState(() =>
    intent?.type === "open-mock" ? (catalog.mocks.find((m) => m.id === intent.id) ?? null) : null,
  );
  const requestedActive = requested ? activeAttempt(state.progress, requested.id) : undefined;
  const [starting, setStarting] = useState<MockTest | null>(
    requested && !requestedActive ? requested : null,
  );

  useEffect(() => {
    if (!requested) return;
    takeIntent("open-mock");
    if (requestedActive) nav.push({ name: "attempt", id: requestedActive.id });
    // Only once, for the intent this screen was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);

  const olympiads = useMemo(
    () => Array.from(new Set(catalog.mocks.map((m) => m.olympiad).filter(Boolean))).sort(),
    [catalog.mocks],
  );
  const list = catalog.mocks
    .filter(
      (m) =>
        (grade === "all" || m.grade === grade) &&
        (subject === "all" || m.subject === subject) &&
        (olympiad === "all" || m.olympiad === olympiad),
    )
    .sort(
      (a, b) =>
        a.grade - b.grade ||
        a.subject.localeCompare(b.subject) ||
        a.title.localeCompare(b.title, "ru"),
    );

  const open = (m: MockTest) => {
    const active = activeAttempt(state.progress, m.id, now);
    if (active) nav.push({ name: "attempt", id: active.id });
    else setStarting(m);
  };

  return (
    <div className="ol-screen ol-mocks">
      <PageHeader
        title="Пробники"
        subtitle="Как настоящая олимпиада: таймер, задания и разбор сразу после финиша"
      />
      <section className="ol-card ol-filters ol-filters--inline" aria-label="Фильтры">
        <label className="ol-field">
          <span className="ol-field-label">Класс</span>
          <Select
            label="Класс"
            value={String(grade)}
            options={[
              { value: "all", label: "Все классы" },
              { value: "4", label: "4 класс" },
              { value: "5", label: "5 класс" },
              { value: "6", label: "6 класс" },
            ]}
            onChange={(v) => setGrade(v === "all" ? "all" : (Number(v) as Grade))}
          />
        </label>
        <label className="ol-field">
          <span className="ol-field-label">Предмет</span>
          <Select
            label="Предмет"
            value={subject}
            options={[
              { value: "all", label: "Оба предмета" },
              { value: "math", label: "Математика" },
              { value: "info", label: "Информатика" },
            ]}
            onChange={(v) => setSubject(v as Subject | "all")}
          />
        </label>
        {olympiads.length > 1 && (
          <label className="ol-field">
            <span className="ol-field-label">Олимпиада</span>
            <Select
              label="Олимпиада"
              value={olympiad}
              options={[
                { value: "all", label: "Все олимпиады" },
                ...olympiads.map((o) => ({ value: o, label: o })),
              ]}
              onChange={setOlympiad}
            />
          </label>
        )}
      </section>

      {!list.length ? (
        <EmptyState
          icon={<ClipboardCheck size={32} />}
          title="Пробников с такими условиями пока нет"
          text="Попробуй другой класс или предмет."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setGrade("all");
                setSubject("all");
                setOlympiad("all");
              }}
            >
              Показать все пробники
            </Button>
          }
        />
      ) : (
        <div className="ol-mock-list">
          {list.map((m) => {
            const attempts = attemptsForTest(state.progress, m.id);
            const active = activeAttempt(state.progress, m.id, now);
            // Time ran out while the app was closed: the result is one tap away.
            const overdue = active ? undefined : attempts.find((a) => !a.finished && a.ends <= now);
            const best = bestResult(attempts);
            const finished = attempts.filter((a) => a.finished).length;
            return (
              <article key={m.id} className={`ol-card ol-mock-card subject-${m.subject}`}>
                <div className="ol-mock-card-top">
                  <span className="ol-event-subject">{m.olympiad || "Пробный тур"}</span>
                  {m.demo && <span className="ol-badge ol-badge--demo">Учебный</span>}
                </div>
                <h2>{mockTitle(m)}</h2>
                <ul className="ol-mock-meta">
                  <li>
                    <Clock size={16} aria-hidden /> {plural(m.minutes, WORDS.minute)}
                  </li>
                  <li>
                    <ListChecks size={16} aria-hidden /> {plural(mockTaskCount(m), WORDS.task)}
                  </li>
                  {m.randomize && (
                    <li>
                      <Shuffle size={16} aria-hidden /> Каждый раз новые задания
                    </li>
                  )}
                </ul>
                <p className="ol-mock-result">
                  {active ? (
                    <TimeLeft ends={active.ends} />
                  ) : overdue ? (
                    "Время вышло – ответы сохранены, осталось узнать результат"
                  ) : best ? (
                    `Лучший результат: ${best.score} из ${plural(best.max, WORDS.pointGen)} · ${plural(finished, WORDS.attempt)}`
                  ) : (
                    "Попыток ещё не было"
                  )}
                </p>
                {overdue ? (
                  <Button
                    size="large"
                    stretched
                    onClick={() => nav.push({ name: "attempt", id: overdue.id })}
                  >
                    Узнать результат
                  </Button>
                ) : (
                  <Button
                    size="large"
                    stretched
                    variant={active || !finished ? "primary" : "secondary"}
                    onClick={() => open(m)}
                  >
                    {active ? "Продолжить" : finished ? "Пройти ещё раз" : "Начать пробник"}
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      )}
      <StartMockDialog test={starting} onOpenChange={(v) => !v && setStarting(null)} />
    </div>
  );
}
