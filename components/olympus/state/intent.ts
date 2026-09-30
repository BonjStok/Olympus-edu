"use client";
/**
 * One-shot intents passed between screens without polluting the URL,
 * e.g. «open the start dialog of this mock» from a deep link.
 */
import { useSyncExternalStore } from "react";

type Intent = { type: "open-mock"; id: string } | { type: "pick-region" } | null;

let current: Intent = null;
const listeners = new Set<() => void>();

export function setIntent(intent: Intent): void {
  current = intent;
  listeners.forEach((l) => l());
}

export function takeIntent<T extends NonNullable<Intent>["type"]>(
  type: T,
): Extract<Intent, { type: T }> | null {
  if (current?.type !== type) return null;
  const value = current as Extract<Intent, { type: T }>;
  current = null;
  return value;
}

export function useIntent(): Intent {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
