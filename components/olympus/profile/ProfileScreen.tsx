"use client";
/**
 * «Я»: who you are (MAX or guest – and what that means), your class and region,
 * olympiads, achievements, mock history; documents and the discreet teacher entry.
 */
import { Avatar, Button, CellAction, CellHeader, CellList, CellSimple } from "@maxhub/max-ui";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  GraduationCap,
  Info,
  MapPin,
  Medal,
  ShieldCheck,
  Star,
  Trophy,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { errorMessage } from "@/lib/client/api";
import { isInsideMax, launchDiagnostics, openExternal } from "@/lib/client/max-bridge";
import { registeredEvents } from "@/lib/ui/calendar";
import { eventDateLabel } from "@/lib/ui/calendar-labels";
import { formatDateTime, todayIso } from "@/lib/ui/dates";
import { SUBJECT_LABEL } from "@/lib/ui/format";
import { mockTitle } from "@/lib/ui/mocks";
import { ADMIN_HOME } from "@/lib/ui/navigation";
import { plural, pluralForm, WORDS } from "@/lib/ui/plural";
import {
  attemptsOf,
  earnedStars,
  medalCount,
  medalStates,
  nextMedal,
  solvedCount,
  starCount,
} from "@/lib/ui/progress";
import { useNow } from "../hooks/useNow";
import { ContextDialog } from "../shared/ContextPicker";
import { PageHeader, SectionTitle } from "../shared/layout";
import { useCatalog, useData } from "../state/data";
import { contextLabel, useLearner } from "../state/learner";
import { useNav } from "../state/navigation";
import { useToast } from "../state/toast";

function GuestCard() {
  const { state } = useData();
  const inMax = isInsideMax();
  const max = launchDiagnostics();
  return (
    <section className="ol-card ol-guest" aria-labelledby="guest-title">
      <h2 id="guest-title">Ты занимаешься как гость</h2>
      <p>
        Прогресс сохраняется на сервере и привязан к этому устройству и браузеру. Если очистить
        данные браузера, доступ к нему можно потерять.
      </p>
      {inMax ? (
        <>
          <p>
            {state.signInError
              ? "Не получилось войти через MAX. Закрой Олимпус и открой его снова из чата с ботом."
              : "Вход через MAX выполняется сам, когда Олимпус открыт из чата с ботом."}
          </p>
          <p>
            Состояние входа: мост MAX — {max.bridge ? "есть" : "нет"}; данные запуска —
            {max.bridgeData ? " в мосте" : max.urlData ? " в ссылке" : " не получены"}
            {max.platform ? `; платформа — ${max.platform}` : ""}.
          </p>
        </>
      ) : state.features.max ? (
        <>
          <p>
            Открой Олимпус в MAX – вход произойдёт сам, без паролей, и прогресс будет виден на
            телефоне и компьютере.
          </p>
          {state.features.botName && (
            <Button
              size="large"
              onClick={() => openExternal(`https://max.ru/${state.features.botName}`)}
            >
              Открыть в MAX
            </Button>
          )}
        </>
      ) : (
        <p>
          Вход через MAX на этом сервере пока не настроен – занимайся как гость, всё сохранится.
        </p>
      )}
    </section>
  );
}

export function ProfileScreen() {
  const data = useData();
  const catalog = useCatalog();
  const learner = useLearner();
  const nav = useNav();
  const toast = useToast();
  const [contextOpen, setContextOpen] = useState<null | "all" | "region">(null);
  const now = useNow();
  const { state } = data;
  const p = state.progress;
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const stars = starCount(p);
  const solved = solvedCount(p);
  const medals = medalCount(p);
  const mine = registeredEvents(catalog.olympiads, p, today);
  const attempts = attemptsOf(p);
  const starList = earnedStars(p);

  const unregister = async (id: string, title: string) => {
    try {
      await data.setRegistration(id, false);
      toast.info(`«${title}» убрана из профиля`, {
        label: "Вернуть",
        onClick: () =>
          void data.setRegistration(id, true).catch((e) => toast.error(errorMessage(e))),
      });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="ol-screen ol-profile">
      <PageHeader title="Я" />
      <section className="ol-card ol-profile-head">
        <Avatar.Container size={64} form="circle">
          {state.profile.name ? (
            <Avatar.Text gradient="blue">
              {state.profile.name.slice(0, 1).toUpperCase()}
            </Avatar.Text>
          ) : (
            <Avatar.Icon>
              <UserRound size={30} aria-hidden />
            </Avatar.Icon>
          )}
        </Avatar.Container>
        <div>
          <h2>{state.profile.name ?? "Гость"}</h2>
          <p>
            {state.profile.max ? "Вход через MAX · прогресс на всех устройствах" : "Гостевой режим"}
          </p>
        </div>
      </section>
      {!state.profile.max && <GuestCard />}

      <CellList mode="island" header={<CellHeader>Мои настройки</CellHeader>}>
        <CellSimple
          as="button"
          showChevron
          before={<GraduationCap size={22} aria-hidden />}
          title="Класс и предмет"
          subtitle={contextLabel(learner)}
          onClick={() => setContextOpen("all")}
        />
        <CellSimple
          as="button"
          showChevron
          before={<MapPin size={22} aria-hidden />}
          title="Мой регион"
          subtitle={learner.region || "Не выбран – показываем олимпиады всех регионов"}
          onClick={() => setContextOpen("region")}
        />
      </CellList>

      <section aria-labelledby="profile-olympiads">
        <SectionTitle id="profile-olympiads" count={mine.length || undefined}>
          Мои олимпиады
        </SectionTitle>
        {mine.length ? (
          <CellList mode="island">
            {mine.map(({ event, timing }) => (
              <CellSimple
                key={event.id}
                before={<CalendarDays size={22} aria-hidden />}
                title={event.title}
                subtitle={`${eventDateLabel(event, year)}${timing.past ? " · прошла" : ""}`}
                after={
                  <span className="ol-cell-actions">
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() =>
                        nav.reset({ tab: "calendar", stack: [{ name: "event", id: event.id }] })
                      }
                    >
                      Открыть
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => void unregister(event.id, event.title)}
                    >
                      Убрать
                    </Button>
                  </span>
                }
              />
            ))}
          </CellList>
        ) : (
          <p className="ol-note">
            Пока пусто. Открой олимпиаду в разделе «Олимпиады» и нажми «Я участвую» – она появится
            здесь.
          </p>
        )}
      </section>

      <section aria-labelledby="profile-stats">
        <SectionTitle id="profile-stats">Достижения</SectionTitle>
        <div className="ol-stats">
          <div className="ol-card">
            <Star size={22} aria-hidden />
            <b>{stars}</b>
            <span>{pluralForm(stars, WORDS.star)} за темы</span>
          </div>
          <div className="ol-card">
            <CheckCircle2 size={22} aria-hidden />
            <b>{solved}</b>
            <span>{pluralForm(solved, WORDS.solvedProblem)}</span>
          </div>
          <div className="ol-card">
            <Trophy size={22} aria-hidden />
            <b>{medals}</b>
            <span>{pluralForm(medals, WORDS.medal)}</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="profile-medals">
        <SectionTitle id="profile-medals">Медали</SectionTitle>
        {(["math", "info"] as const).map((s) => {
          const n = solvedCount(p, s);
          const nm = nextMedal(n);
          return (
            <div key={s} className="ol-card ol-medals">
              <div className="ol-medals-head">
                <b>{SUBJECT_LABEL[s]}</b>
                <span>Решено: {plural(n, WORDS.problem)}</span>
              </div>
              <ul className="ol-medal-row">
                {medalStates(n).map((m) => (
                  <li key={m.name} className={m.earned ? "is-earned" : ""}>
                    <Medal size={24} aria-hidden />
                    <span>{m.name}</span>
                    <small>{plural(m.threshold, WORDS.problem)}</small>
                  </li>
                ))}
              </ul>
              <p className="ol-medals-next">
                {nm
                  ? `Ещё ${plural(nm.left, WORDS.problem)} до медали «${nm.name}»`
                  : "Все медали собраны!"}
              </p>
            </div>
          );
        })}
      </section>

      <section aria-labelledby="profile-stars">
        <SectionTitle id="profile-stars" count={starList.length || undefined}>
          Звёзды за темы
        </SectionTitle>
        {starList.length ? (
          <ul className="ol-star-list">
            {starList.map((s) => (
              <li key={s.key} className="ol-badge ol-badge--star">
                <Star size={14} aria-hidden /> {s.title} ·{" "}
                {s.type === "practice" ? "практика" : "теория"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ol-note">
            Пройди теорию или реши три задачи в любой теме – и получишь первую звезду.
          </p>
        )}
      </section>

      <section aria-labelledby="profile-mocks">
        <SectionTitle id="profile-mocks" count={attempts.length || undefined}>
          История пробников
        </SectionTitle>
        {attempts.length ? (
          <CellList mode="island">
            {attempts.map((a) => (
              <CellSimple
                key={a.id}
                as="button"
                showChevron
                before={<ClipboardCheck size={22} aria-hidden />}
                title={mockTitle({ title: a.title, subject: a.subject })}
                subtitle={formatDateTime(a.started)}
                after={
                  a.finished ? (
                    <span className="ol-badge">
                      {a.score ?? 0} из {a.max ?? 0}
                    </span>
                  ) : a.ends > now ? (
                    <span className="ol-badge ol-badge--warn">Идёт</span>
                  ) : (
                    <span className="ol-badge">Время вышло</span>
                  )
                }
                onClick={() => nav.reset({ tab: "mocks", stack: [{ name: "attempt", id: a.id }] })}
              />
            ))}
          </CellList>
        ) : (
          <p className="ol-note">Пройди первый пробник – здесь появятся результаты.</p>
        )}
      </section>

      <CellList mode="island" header={<CellHeader>О приложении</CellHeader>}>
        <CellSimple
          as="button"
          showChevron
          before={<Info size={22} aria-hidden />}
          title="Об Олимпусе"
          subtitle="Возраст 6+, контакты и поддержка"
          onClick={() => nav.push({ name: "legal", doc: "about" })}
        />
        <CellSimple
          as="button"
          showChevron
          before={<ShieldCheck size={22} aria-hidden />}
          title="Политика конфиденциальности"
          onClick={() => nav.push({ name: "legal", doc: "privacy" })}
        />
        <CellSimple
          as="button"
          showChevron
          before={<FileText size={22} aria-hidden />}
          title="Условия использования"
          onClick={() => nav.push({ name: "legal", doc: "terms" })}
        />
      </CellList>

      <CellList mode="island" className="ol-teacher-entry">
        <CellAction mode="secondary" height="compact" onClick={() => nav.reset(ADMIN_HOME)}>
          {state.profile.admin ? "Для учителя · вход выполнен" : "Для учителя"}
        </CellAction>
      </CellList>
      <ContextDialog
        open={!!contextOpen}
        onOpenChange={(v) => !v && setContextOpen(null)}
        focusRegion={contextOpen === "region"}
      />
    </div>
  );
}
