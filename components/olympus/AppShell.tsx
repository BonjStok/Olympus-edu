"use client";
/**
 * Layout: sidebar on desktop, top bar + bottom tab bar on phones (moves to the top
 * when MAX launched us from its own tab bar). Also runs the startup sequence:
 * session → data → deep link → `WebApp.ready()`.
 */
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  House,
  Star,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Subject } from "@/lib/domain/types";
import * as bridge from "@/lib/client/max-bridge";
import { sessionStore } from "@/lib/client/storage";
import {
  parseStartParam,
  TAB_LABEL,
  TABS,
  type ChildTab,
  type DeepLink,
} from "@/lib/ui/navigation";
import { plural, WORDS } from "@/lib/ui/plural";
import { starCount } from "@/lib/ui/progress";
import { RunningMockBanner } from "./mocks/RunningMockBanner";
import { Onboarding } from "./onboarding/Onboarding";
import { ScreenRouter } from "./ScreenRouter";
import { ContextChip } from "./shared/ContextPicker";
import { ErrorBanner, Loading, ToastViewport } from "./shared/feedback";
import { buildCatalog, useData, type Catalog } from "./state/data";
import { setIntent } from "./state/intent";
import { useNav, type NavApi } from "./state/navigation";
import { useToast } from "./state/toast";

const TAB_ICON: Record<ChildTab, LucideIcon> = {
  home: House,
  calendar: CalendarDays,
  learn: BookOpen,
  mocks: ClipboardCheck,
  profile: UserRound,
};

const HANDLED_KEY = "olympus.startParamHandled";

function applyDeepLink(
  link: DeepLink,
  catalog: Catalog,
  nav: NavApi,
  notify: (text: string) => void,
) {
  if (link.type === "tab") return nav.reset({ tab: link.tab, stack: [] }, "replace");
  if (link.type === "event") {
    if (catalog.olympiads.some((e) => e.id === link.id))
      return nav.reset({ tab: "calendar", stack: [{ name: "event", id: link.id }] }, "replace");
    notify("Этой олимпиады уже нет в календаре. Посмотри другие");
    return nav.reset({ tab: "calendar", stack: [] }, "replace");
  }
  if (link.type === "topic") {
    if (catalog.topics.some((t) => t.id === link.id))
      return nav.reset(
        { tab: "learn", stack: [{ name: "topic", id: link.id, part: "theory", step: 0 }] },
        "replace",
      );
    notify("Такой темы пока нет. Выбери тему из списка");
    return nav.reset({ tab: "learn", stack: [] }, "replace");
  }
  if (catalog.mocks.some((m) => m.id === link.id)) setIntent({ type: "open-mock", id: link.id });
  else notify("Такого пробника пока нет. Выбери другой");
  nav.reset({ tab: "mocks", stack: [] }, "replace");
}

function useStartup() {
  const data = useData();
  const nav = useNav();
  const toast = useToast();
  const started = useRef(false);
  const linked = useRef(false);
  const { status, records, startParam } = data.state;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void data.start();
  }, [data]);

  useEffect(() => {
    if (status !== "ready" || linked.current) return;
    linked.current = true;
    const raw = data.consumeStartParam() ?? startParam;
    const link = parseStartParam(raw);
    if (!link || sessionStore.get(HANDLED_KEY) === raw) return;
    sessionStore.set(HANDLED_KEY, raw ?? "");
    applyDeepLink(link, buildCatalog(records), nav, (t) => toast.info(t));
  }, [status, records, startParam, data, nav, toast]);

  // Tell MAX the first meaningful screen is ready (hides its loader).
  useEffect(() => {
    if (status !== "loading") bridge.ready();
  }, [status]);

  useEffect(() => {
    if (data.state.signInError) toast.info(data.state.signInError);
  }, [data.state.signInError, toast]);
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement)
    return !el.readOnly && !["checkbox", "radio", "button", "submit", "range"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * The on-screen keyboard is open: a text field has focus and the visible viewport is clearly
 * shorter than it was (iOS shrinks the visual viewport, Android resizes the whole page).
 * Not just «a field has focus»: on Android the keyboard can be hidden while focus stays.
 */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const height = () => vv?.height ?? window.innerHeight;
    let tallest = height();
    let width = window.innerWidth;
    const update = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth; // rotated: start over
        tallest = height();
      }
      tallest = Math.max(tallest, height());
      setOpen(isEditable(document.activeElement) && tallest - height() > 120);
    };
    const later = () => setTimeout(update, 0);
    vv?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      vv?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return open;
}

function accentSubject(nav: NavApi, data: ReturnType<typeof useData>): Subject {
  const screen = nav.screen;
  const { records, progress, settings } = data.state;
  if (screen?.name === "topic") {
    const topic = records.find((r) => r.id === screen.id);
    if (topic && "subject" in topic) return topic.subject;
  }
  if (screen?.name === "attempt") {
    const a = progress[`attempt:${screen.id}`] as { subject?: Subject } | undefined;
    if (a?.subject) return a.subject;
  }
  if (nav.state.tab === "learn") return settings.subject ?? "math";
  return "math";
}

function NavItems({ variant }: { variant: "sidebar" | "tabbar" }) {
  const nav = useNav();
  return (
    <>
      {TABS.map((tab) => {
        const Icon = TAB_ICON[tab];
        const current = nav.state.tab === tab;
        return (
          <button
            key={tab}
            type="button"
            className={`ol-nav-item${current ? " is-current" : ""}`}
            aria-current={current ? "page" : undefined}
            onClick={() => {
              bridge.haptic.selection();
              nav.go(tab);
            }}
          >
            <span className="ol-nav-icon">
              <Icon size={variant === "sidebar" ? 21 : 23} aria-hidden />
            </span>
            <span className="ol-nav-label">{TAB_LABEL[tab]}</span>
          </button>
        );
      })}
    </>
  );
}

function Brand({ onClick }: { onClick(): void }) {
  // The logo leads home, like in most apps.
  return (
    <button type="button" className="ol-brand" onClick={onClick} aria-label="Олимпус – на главную">
      <img src="/olympus-icon-ui.webp" alt="" width={36} height={36} />
      <span>Олимпус</span>
    </button>
  );
}

function Footer() {
  const nav = useNav();
  const open = (doc: "privacy" | "terms" | "about") => nav.push({ name: "legal", doc });
  return (
    <footer className="ol-footer">
      <span>Олимпус · олимпиадная подготовка · 6+</span>
      <nav aria-label="Документы">
        <button type="button" onClick={() => open("about")}>
          О приложении
        </button>
        <button type="button" onClick={() => open("privacy")}>
          Политика конфиденциальности
        </button>
        <button type="button" onClick={() => open("terms")}>
          Условия использования
        </button>
      </nav>
    </footer>
  );
}

export function AppShell() {
  useStartup();
  const data = useData();
  const nav = useNav();
  const [tabbarLaunch, setTabbarLaunch] = useState(false);
  const typing = useKeyboardOpen();
  const { status, error, progress } = data.state;
  const stars = starCount(progress);
  const subject = accentSubject(nav, data);
  const screenName = nav.screen?.name ?? "root";

  useEffect(() => {
    let alive = true;
    void bridge.launchEntryPoint().then((p) => alive && setTabbarLaunch(p === "tabbar"));
    return () => {
      alive = false;
    };
  }, []);

  const admin = nav.state.tab === "admin";
  const onboarding = status === "ready" && !data.state.settings.onboarded && !admin;

  const content = useMemo(() => {
    if (status === "loading") return <Loading label="Открываем Олимпус…" />;
    if (status === "error")
      return (
        <div className="ol-startup-error">
          <ErrorBanner
            title="Не получилось загрузить Олимпус"
            message={error ?? "Проверь интернет и попробуй ещё раз"}
            onRetry={() => void data.start()}
          />
        </div>
      );
    if (onboarding) return <Onboarding />;
    return <ScreenRouter />;
  }, [status, error, data, onboarding]);

  return (
    <div
      className={`ol-app subject-${subject} tab-${nav.state.tab} screen-${screenName}${tabbarLaunch ? " ol-app--top-tabs" : ""}${admin ? " is-admin" : ""}${onboarding ? " is-onboarding" : ""}${typing ? " is-typing" : ""}`}
    >
      <a className="ol-skip" href="#main">
        К содержимому
      </a>
      <aside className="ol-sidebar" aria-label="Разделы">
        <Brand onClick={() => nav.go("home")} />
        <p className="ol-sidebar-tagline">Олимпиады по математике и информатике · 4–6 классы</p>
        <nav className="ol-sidebar-nav" aria-label="Основные разделы">
          <NavItems variant="sidebar" />
        </nav>
        <button type="button" className="ol-mini-progress" onClick={() => nav.go("profile")}>
          <Star size={20} aria-hidden />
          <span>
            <b>{plural(stars, WORDS.star)}</b>
            <small>за теорию и практику</small>
          </span>
        </button>
      </aside>
      <div className="ol-column">
        <header className="ol-topbar">
          <Brand onClick={() => nav.go("home")} />
          {!admin && <ContextChip />}
          <button
            type="button"
            className="ol-topbar-stars"
            onClick={() => nav.go("profile")}
            aria-label={`Звёзд: ${stars}. Открыть профиль`}
          >
            <Star size={18} aria-hidden />
            <span>{stars}</span>
          </button>
        </header>
        <main id="main" className="ol-main" tabIndex={-1}>
          {!admin && !onboarding && status === "ready" && <RunningMockBanner />}
          {content}
          <Footer />
        </main>
      </div>
      <nav className="ol-tabbar" aria-label="Основные разделы">
        <NavItems variant="tabbar" />
      </nav>
      <ToastViewport />
    </div>
  );
}
