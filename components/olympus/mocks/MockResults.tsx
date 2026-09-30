"use client";
/** Results of a finished mock: score, unchecked code tasks, review with solutions, share. */
import { Button } from "@maxhub/max-ui";
import {
  CheckCircle2,
  CircleHelp,
  Hourglass,
  Medal,
  RotateCcw,
  Share2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { MockAttempt, ReviewedTask } from "@/lib/domain/types";
import { errorMessage, isUnknownAction } from "@/lib/client/api";
import { canShareToMax, haptic, miniAppLink, shareToMax } from "@/lib/client/max-bridge";
import { formatDateTime } from "@/lib/ui/dates";
import {
  answerText,
  firstMistakeTopic,
  mockTitle,
  pendingCount,
  resultStatus,
  type ResultStatus,
} from "@/lib/ui/mocks";
import { plural, WORDS } from "@/lib/ui/plural";
import { percent } from "@/lib/ui/progress";
import { isGenericTaskTitle } from "@/lib/ui/format";
import { PageHeader } from "../shared/layout";
import { useData } from "../state/data";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { Prompt } from "../training/Prompt";

const STATUS: Record<ResultStatus, { label: string; icon: typeof CheckCircle2 }> = {
  correct: { label: "Верно", icon: CheckCircle2 },
  wrong: { label: "Неверно", icon: XCircle },
  unchecked: { label: "Не проверено", icon: Hourglass },
  "self-check": { label: "Самопроверка", icon: CircleHelp },
};

export function MockResults({
  attempt,
  onChange,
}: {
  attempt: MockAttempt<ReviewedTask>;
  onChange(a: MockAttempt): void;
}) {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const score = attempt.score ?? 0;
  const max = attempt.max ?? 0;
  const unchecked = pendingCount(attempt);
  const mistakeTopic = firstMistakeTopic(attempt);
  const shareable = canShareToMax();

  const recheck = async () => {
    setPending("recheck");
    try {
      const next = await data.recheckMock(attempt.id);
      onChange(next);
      const still = pendingCount(next);
      if (still) toast.info("Проверка программ пока не работает. Попробуем позже");
      else toast.success("Готово! Все задания проверены");
    } catch (e) {
      toast.error(
        isUnknownAction(e) ? "Повторная проверка пока недоступна. Попробуй позже" : errorMessage(e),
      );
    } finally {
      setPending(null);
    }
  };

  const selfCheck = async (taskId: string, correct: boolean) => {
    setPending(taskId);
    try {
      onChange(await data.markMockProof(attempt.id, taskId, correct));
      haptic.selection();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(null);
    }
  };

  const share = async () => {
    const ok = await shareToMax({
      text: `Мой результат в пробнике «${attempt.title}»: ${score} из ${plural(max, WORDS.pointGen)}. Готовлюсь к олимпиадам в Олимпусе!`,
      link: miniAppLink(data.state.features.botName ?? undefined, `mock_${attempt.testId}`),
    });
    if (ok) toast.success("Результат отправлен");
  };

  return (
    <div className="ol-screen ol-results">
      <PageHeader
        back="Пробники"
        eyebrow="Результат пробника"
        title={mockTitle({ title: attempt.title, subject: attempt.subject })}
      />
      <section className="ol-card ol-result-hero" aria-live="polite">
        <span className="ol-result-icon" aria-hidden>
          <Medal size={36} />
        </span>
        <p className="ol-result-score">
          <b>{score}</b> из {plural(max, WORDS.pointGen)}
        </p>
        <p className="ol-result-sub">
          {percent(score, max)}% ·{" "}
          {attempt.finishedAt ? formatDateTime(attempt.finishedAt) : "попытка сохранена"}
        </p>
        {unchecked > 0 && (
          <div className="ol-note ol-note--warn">
            <Hourglass size={18} aria-hidden />
            <span>
              {plural(unchecked, WORDS.task)} ещё не проверены: проверка программ сейчас не
              работает. Баллы добавятся, когда проверим.
            </span>
            <Button
              size="small"
              variant="secondary"
              loading={pending === "recheck"}
              iconBefore={<RotateCcw size={16} aria-hidden />}
              onClick={() => void recheck()}
            >
              Проверить ещё раз
            </Button>
          </div>
        )}
        <div className="ol-actions">
          {mistakeTopic && (
            <Button
              size="large"
              stretched
              onClick={() =>
                nav.reset({
                  tab: "learn",
                  stack: [{ name: "topic", id: mistakeTopic, part: "practice", step: 0 }],
                })
              }
            >
              Разобрать ошибки
            </Button>
          )}
          <Button size="large" stretched variant="secondary" onClick={() => nav.go("mocks")}>
            К пробникам
          </Button>
          {shareable && (
            <Button
              size="large"
              stretched
              variant="ghost"
              iconBefore={<Share2 size={18} aria-hidden />}
              onClick={() => void share()}
            >
              Поделиться результатом
            </Button>
          )}
        </div>
      </section>

      <h2 className="ol-section-heading">Разбор заданий</h2>
      <ol className="ol-review">
        {attempt.tasks.map((t, i) => {
          const r = attempt.results?.find((x) => x.id === t.id);
          const status = resultStatus(r, t);
          const S = STATUS[status];
          const answer = answerText(attempt.answers?.[t.id]);
          return (
            <li key={t.id} className={`ol-card ol-review-item is-${status}`}>
              <details open={status !== "correct"}>
                <summary>
                  <span className="ol-review-num">Задание {i + 1}</span>
                  <span className={`ol-badge ol-badge--${status}`}>
                    <S.icon size={14} aria-hidden /> {S.label}
                  </span>
                  <span className="ol-review-points">
                    {r?.points ?? 0} из {plural(r?.max ?? t.points ?? 1, WORDS.pointGen)}
                  </span>
                </summary>
                {!isGenericTaskTitle(t.title) && <h3>{t.title}</h3>}
                <Prompt text={t.prompt} />
                <div className="ol-review-answer">
                  <span className="ol-field-label">Твой ответ</span>
                  {answer ? (
                    t.type === "number" ? (
                      <p>{answer}</p>
                    ) : (
                      <pre className="ol-code">{answer}</pre>
                    )
                  ) : (
                    <p className="ol-muted">Без ответа</p>
                  )}
                </div>
                {t.type === "number" && t.answer !== undefined && (
                  <p className="ol-solution-answer">
                    Правильный ответ: <b>{t.answer}</b>
                  </p>
                )}
                {status === "unchecked" && (
                  <p className="ol-note">
                    Не проверено – проверим, когда заработает сервер проверки.
                  </p>
                )}
                {t.solution && (
                  <div className="ol-solution">
                    <span className="ol-field-label">Разбор</span>
                    <pre className="ol-solution-text">{t.solution}</pre>
                  </div>
                )}
                {t.type === "proof" && (
                  <div className="ol-actions">
                    <Button
                      size="medium"
                      stretched
                      loading={pending === t.id}
                      variant={r?.correct ? "primary" : "secondary"}
                      onClick={() => void selfCheck(t.id, true)}
                    >
                      Моё рассуждение верное
                    </Button>
                    <Button
                      size="medium"
                      stretched
                      variant="secondary"
                      disabled={pending === t.id}
                      onClick={() => void selfCheck(t.id, false)}
                    >
                      Есть ошибка
                    </Button>
                  </div>
                )}
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
