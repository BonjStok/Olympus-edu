"use client";
/**
 * One olympiad: key facts, how to take part and the child's confirmation.
 * - `link`: «Зарегистрироваться на сайте» → on return «Получилось зарегистрироваться?»;
 * - `school`: «Как участвовать» + «Записывает школа – спроси учителя» + «Я участвую».
 *
 * The catalogue carries summaries only: the description, «Проверено … · источник» and the picture
 * are loaded here (action `olympiad`) while everything else is already on screen.
 */
import { Button, CellList, CellSimple } from "@maxhub/max-ui";
import {
  ArrowUpRight,
  BadgeCheck,
  CalendarDays,
  Clock,
  GraduationCap,
  MapPin,
  RotateCcw,
  School,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/client/api";
import { haptic, openExternal } from "@/lib/client/max-bridge";
import type { OlympiadSummary } from "@/lib/domain/types";
import {
  eventTiming,
  inlineDetails,
  isSchoolRegistration,
  sourceDomain,
  type OlympiadDetails,
} from "@/lib/ui/calendar";
import {
  eventDateLabel,
  placeLabel,
  registrationLine,
  SCHOOL_LINE,
} from "@/lib/ui/calendar-labels";
import { formatDay, isIsoDay, todayIso } from "@/lib/ui/dates";
import { gradesLabel, priceLabel, subjectsLabel } from "@/lib/ui/format";
import { useResource } from "../hooks/useResource";
import { EmptyState } from "../shared/feedback";
import { PageHeader } from "../shared/layout";
import { useCatalog, useData } from "../state/data";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";
import { DemoBadge, RegisteredBadge } from "./EventCard";

type Ask = "idle" | "asking" | "later";

/** The picture the teacher added to the olympiad; hidden if it cannot be loaded. */
function EventImage({ src, title }: { src: string; title: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <figure className="ol-event-image">
      <img
        src={src}
        alt={`Картинка олимпиады «${title}»`}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    </figure>
  );
}

type DetailsState =
  | { status: "loading" }
  | { status: "error"; message: string; retry(): void }
  /** `details: null` – an older server that cannot send them: show the summary only. */
  | { status: "ready"; details: OlympiadDetails | null };

/**
 * Description, source and picture of the olympiad: taken from the catalogue entry when it is
 * complete (older server, teacher), from the session cache, or loaded once with `olympiad`.
 */
function useOlympiadDetails(event: OlympiadSummary | undefined): DetailsState {
  const data = useData();
  const known: OlympiadDetails | null = event
    ? (inlineDetails(event) ?? data.state.olympiadDetails[event.id] ?? null)
    : null;
  const resource = useResource<{ details: OlympiadDetails | null }>(
    async () => ({ details: event ? await data.loadOlympiad(event.id) : null }),
    { initial: known ? { details: known } : null, skip: !event || !!known },
  );
  if (known) return { status: "ready", details: known };
  if (resource.data) return { status: "ready", details: resource.data.details };
  if (resource.error) return { status: "error", message: resource.error, retry: resource.retry };
  return { status: "loading" };
}

export function EventScreen({ id }: { id: string }) {
  const catalog = useCatalog();
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const event = catalog.olympiads.find((e) => e.id === id);
  const details = useOlympiadDetails(event);
  const [ask, setAsk] = useState<Ask>("idle");
  const [pending, setPending] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leftForSite = useRef(false);
  const today = todayIso();
  const year = Number(today.slice(0, 4));

  // Ask «Получилось?» when the child comes back from the organiser's site.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && leftForSite.current) {
        leftForSite.current = false;
        setAsk("asking");
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (!event)
    return (
      <div className="ol-screen">
        <PageHeader title="Олимпиада не найдена" back="Олимпиады" />
        <EmptyState
          title="Этой олимпиады больше нет в календаре"
          text="Возможно, её убрали или перенесли. Посмотри другие олимпиады."
          action={<Button onClick={() => nav.go("calendar")}>К олимпиадам</Button>}
        />
      </div>
    );

  const timing = eventTiming(event, today);
  const registered = !!data.state.progress[`registration:${event.id}`];
  const school = isSchoolRegistration(event);
  const status = registrationLine(event, timing, year);
  const canRegister = !timing.past && timing.registration !== "closed";
  const info = details.status === "ready" ? details.details : null;
  const source = info?.source;
  const verifiedAt = info?.verifiedAt;
  const domain = sourceDomain(source);
  const verified = isIsoDay(verifiedAt) ? `Проверено ${formatDay(verifiedAt, year)}` : "";

  const setRegistered = async (yes: boolean) => {
    setPending(yes ? "yes" : "no");
    setError(null);
    try {
      await data.setRegistration(event.id, yes);
      setAsk("idle");
      if (yes) {
        haptic.success();
        toast.success("Готово! Олимпиада в твоём профиле и на главной");
      } else {
        toast.info("Отметка убрана", {
          label: "Вернуть",
          onClick: () => void data.setRegistration(event.id, true).catch(() => undefined),
        });
      }
    } catch (e) {
      setError(errorMessage(e));
      haptic.error();
    } finally {
      setPending(null);
    }
  };

  const openSite = () => {
    if (!event.url) return;
    openExternal(event.url);
    if (!registered && !school && canRegister) {
      leftForSite.current = true;
      // In MAX the page may stay visible (link opens in a browser tab): ask right away.
      setTimeout(() => {
        if (leftForSite.current && document.visibilityState === "visible") {
          leftForSite.current = false;
          setAsk("asking");
        }
      }, 1500);
    }
  };

  return (
    <div className={`ol-screen ol-event subject-${event.subject}`}>
      <PageHeader
        back="Олимпиады"
        eyebrow={`${subjectsLabel(event)} · ${gradesLabel(event.grades)}`}
        title={event.title}
        subtitle={
          (event.demo || registered || event.featured) && (
            <span className="ol-event-badges">
              {event.featured && <span className="ol-badge ol-badge--max">Рекомендуем</span>}
              {event.demo && <DemoBadge />}
              {registered && <RegisteredBadge />}
            </span>
          )
        }
      />

      {info?.image && !info.image.startsWith("/olympiad-default") && (
        <EventImage src={info.image} title={event.title} />
      )}

      {event.demo && (
        <p className="ol-note ol-note--demo">
          Это пример олимпиады для знакомства с приложением. Настоящие олимпиады в календаре – без
          этой пометки.
        </p>
      )}

      <CellList mode="island" className="ol-facts">
        <CellSimple
          before={<Clock size={22} aria-hidden />}
          overline="Регистрация"
          title={<span className={`ol-status ol-status--${status.tone}`}>{status.text}</span>}
          subtitle={
            isIsoDay(event.registrationStart) && timing.registration !== "not-started"
              ? `Открыта с ${formatDay(event.registrationStart, year)}`
              : undefined
          }
        />
        <CellSimple
          before={<CalendarDays size={22} aria-hidden />}
          overline="Олимпиада"
          title={eventDateLabel(event, year)}
          subtitle={event.stage}
        />
        <CellSimple
          before={<MapPin size={22} aria-hidden />}
          overline="Где"
          title={placeLabel(event)}
        />
        <CellSimple
          before={<GraduationCap size={22} aria-hidden />}
          overline="Для кого"
          title={gradesLabel(event.grades)}
        />
        {priceLabel(event.price) && (
          <CellSimple
            before={<Wallet size={22} aria-hidden />}
            overline="Участие"
            title={priceLabel(event.price)}
          />
        )}
      </CellList>

      {details.status === "loading" ? (
        <div className="ol-event-details-loading" aria-busy="true">
          <span className="ol-visually-hidden">Загружаем описание…</span>
          <span className="ol-skeleton-line" aria-hidden />
          <span className="ol-skeleton-line" aria-hidden />
          <span className="ol-skeleton-line ol-skeleton-line--short" aria-hidden />
        </div>
      ) : details.status === "error" ? (
        <div className="ol-note ol-event-details-error" aria-live="polite">
          <span>Описание не загрузилось. {details.message}</span>
          <Button
            size="small"
            variant="secondary"
            onClick={details.retry}
            iconBefore={<RotateCcw size={16} aria-hidden />}
          >
            Попробовать ещё раз
          </Button>
        </div>
      ) : (
        info?.description && <p className="ol-event-description">{info.description}</p>
      )}

      <section className="ol-card ol-register" aria-label="Участие">
        {registered ? (
          <>
            <div className="ol-register-done">
              <BadgeCheck size={28} aria-hidden />
              <div>
                <b>Ты участвуешь</b>
                <p>Олимпиада сохранена в профиле. Удачи – и не забудь подготовиться!</p>
              </div>
            </div>
            <div className="ol-actions">
              {event.url && (
                <Button
                  variant="secondary"
                  size="large"
                  stretched
                  onClick={openSite}
                  iconAfter={<ArrowUpRight size={18} aria-hidden />}
                >
                  Сайт олимпиады
                </Button>
              )}
              <Button variant="primary" size="large" stretched onClick={() => nav.go("learn")}>
                Готовиться
              </Button>
            </div>
            <Button
              variant="ghost"
              size="medium"
              loading={pending === "no"}
              onClick={() => void setRegistered(false)}
            >
              Убрать отметку
            </Button>
          </>
        ) : ask === "asking" ? (
          <div className="ol-register-ask" role="group" aria-labelledby="ask-title">
            <h2 id="ask-title">Получилось зарегистрироваться?</h2>
            <p>Отметь – и олимпиада появится в профиле и на главной.</p>
            <div className="ol-actions">
              <Button
                size="large"
                stretched
                loading={pending === "yes"}
                onClick={() => void setRegistered(true)}
              >
                Да, я участвую
              </Button>
              <Button size="large" stretched variant="secondary" onClick={() => setAsk("later")}>
                Ещё нет
              </Button>
            </div>
          </div>
        ) : (
          <>
            {ask === "later" && (
              <p className="ol-note" role="status">
                Хорошо! Вернуться к регистрации можно в любой момент.
              </p>
            )}
            {school && canRegister && (
              <div className="ol-register-school">
                <School size={24} aria-hidden />
                <p>
                  <b>{SCHOOL_LINE}.</b> Отдельно регистрироваться не нужно: школа сама подаёт списки
                  участников. Подробности – по кнопке «Как участвовать».
                </p>
              </div>
            )}
            {!canRegister && (
              <p className="ol-note">
                {timing.past
                  ? "Эта олимпиада уже прошла. Посмотри другие олимпиады в календаре."
                  : "Регистрация на эту олимпиаду закрыта. Если регистрация у тебя уже есть – отметь это."}
              </p>
            )}
            <div className="ol-actions">
              {event.url ? (
                <Button
                  size="large"
                  stretched
                  variant={canRegister ? "primary" : "secondary"}
                  onClick={openSite}
                  iconAfter={<ArrowUpRight size={18} aria-hidden />}
                >
                  {school
                    ? "Как участвовать"
                    : canRegister
                      ? "Зарегистрироваться на сайте"
                      : "Сайт олимпиады"}
                </Button>
              ) : (
                <p className="ol-note">Ссылку на регистрацию скоро добавим.</p>
              )}
              {!timing.past && (
                <Button
                  size="large"
                  stretched
                  variant={school && canRegister ? "primary" : "secondary"}
                  loading={pending === "yes"}
                  onClick={() => void setRegistered(true)}
                >
                  Я участвую
                </Button>
              )}
            </div>
            {!school && canRegister && (
              <p className="ol-field-hint">
                Регистрация уже есть? Нажми «Я участвую» – олимпиада появится в профиле.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="ol-field-error" role="alert">
            {error}
          </p>
        )}
      </section>

      {details.status === "loading" && (
        <p className="ol-source" aria-hidden>
          <span className="ol-skeleton-line ol-skeleton-line--source" />
        </p>
      )}
      {(verified || domain) && (
        <p className="ol-source">
          {verified}
          {verified && domain && " · "}
          {domain && (
            <>
              {verified ? "источник: " : "Источник: "}
              <a
                href={source}
                onClick={(e) => {
                  e.preventDefault();
                  if (source) openExternal(source);
                }}
              >
                {domain}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
