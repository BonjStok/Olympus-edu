"use client";
/** Persistent «Идёт пробник · 38:12 · Вернуться» on every screen while a mock runs. */
import { Clock } from "lucide-react";
import { formatCountdown } from "@/lib/ui/dates";
import { runningAttempt } from "@/lib/ui/progress";
import { useCountdown } from "../hooks/useCountdown";
import { useNow } from "../hooks/useNow";
import { useData } from "../state/data";
import { useNav } from "../state/navigation";

export function RunningMockBanner() {
  const { state } = useData();
  const nav = useNav();
  const now = useNow();
  const attempt = runningAttempt(state.progress, now);
  const left = useCountdown(attempt ? attempt.ends : null);
  const onIt = nav.screen?.name === "attempt" && nav.screen.id === attempt?.id;
  if (!attempt || onIt || left <= 0) return null;
  return (
    <div className="ol-running-mock" role="status">
      <Clock size={18} aria-hidden />
      <span>
        Идёт пробник · <b>{formatCountdown(left)}</b>
      </span>
      <button
        type="button"
        onClick={() => nav.reset({ tab: "mocks", stack: [{ name: "attempt", id: attempt.id }] })}
      >
        Вернуться
      </button>
    </div>
  );
}
