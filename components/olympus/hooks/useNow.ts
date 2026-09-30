"use client";
import { useSyncExternalStore } from "react";
import { serverNow, subscribeClock } from "@/lib/client/clock";

/**
 * Current server time as an external store (for «осталось 12 мин», «идёт попытка»).
 * Refreshed every `STEP` ms, right after the server clock estimate changes and when the
 * app comes back to the foreground – never a stale value from the moment the module loaded.
 */
const STEP = 15_000;
let now = serverNow();
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function refresh() {
  now = serverNow();
  listeners.forEach((l) => l());
}

function start(): () => void {
  const timer = setInterval(refresh, STEP);
  const offClock = subscribeClock(refresh);
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    offClock();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stop) {
    // The value may be long out of date (nobody was listening): React re-reads the snapshot.
    now = serverNow();
    stop = start();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stop) {
      stop();
      stop = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

/** Refreshes the shared clock right away (e.g. after returning to the tab). */
export function touchNow(): void {
  refresh();
}
