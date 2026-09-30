"use client";
import { lazy, Suspense } from "react";
import { CalendarScreen } from "./calendar/CalendarScreen";
import { EventScreen } from "./calendar/EventScreen";
import { HomeScreen } from "./home/HomeScreen";
import { LearnHome } from "./learn/LearnHome";
import { TopicScreen } from "./learn/TopicScreen";
import { LegalScreen } from "./legal/LegalScreen";
import { MockAttemptScreen } from "./mocks/MockAttemptScreen";
import { MocksScreen } from "./mocks/MocksScreen";
import { ProfileScreen } from "./profile/ProfileScreen";
import { Loading } from "./shared/feedback";
import { useNav } from "./state/navigation";

// The teacher's area is never needed by children: load it only on demand.
const AdminScreen = lazy(() => import("./admin/AdminScreen"));
const AdminEditorScreen = lazy(() => import("./admin/AdminEditorScreen"));

export function ScreenRouter() {
  const { state, screen } = useNav();

  if (state.tab === "admin") {
    const base = state.stack[0];
    const kind = base?.name === "admin" ? base.kind : "olympiads";
    return (
      <Suspense fallback={<Loading label="Открываем кабинет учителя…" />}>
        {screen?.name === "admin-edit" ? (
          <AdminEditorScreen
            key={`${screen.kind}:${screen.id}`}
            kind={screen.kind}
            id={screen.id}
          />
        ) : screen?.name === "legal" ? (
          <LegalScreen doc={screen.doc} />
        ) : (
          <AdminScreen kind={kind} />
        )}
      </Suspense>
    );
  }

  if (screen) {
    switch (screen.name) {
      case "event":
        return <EventScreen key={screen.id} id={screen.id} />;
      case "topic":
        return <TopicScreen key={screen.id} id={screen.id} part={screen.part} step={screen.step} />;
      case "attempt":
        return <MockAttemptScreen key={screen.id} id={screen.id} />;
      case "legal":
        return <LegalScreen doc={screen.doc} />;
      default:
        break;
    }
  }

  switch (state.tab) {
    case "home":
      return <HomeScreen />;
    case "calendar":
      return <CalendarScreen />;
    case "learn":
      return <LearnHome />;
    case "mocks":
      return <MocksScreen />;
    case "profile":
      return <ProfileScreen />;
  }
}
