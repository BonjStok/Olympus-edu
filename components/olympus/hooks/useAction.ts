"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/client/api";
import { useToast } from "../state/toast";

export interface ActionState<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * Wraps an async action: tracks `pending`, turns failures into a human message and
 * (by default) shows it as a toast, so nothing fails silently.
 */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  options: { toast?: boolean } = {},
): ActionState<A, R> {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  const alive = useRef(true);
  const busy = useRef(false);
  const showToast = options.toast !== false;

  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: A) => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      setError(null);
      try {
        return await fnRef.current(...args);
      } catch (e) {
        const message = errorMessage(e);
        if (alive.current) setError(message);
        if (showToast) toast.error(message);
        return undefined;
      } finally {
        busy.current = false;
        if (alive.current) setPending(false);
      }
    },
    [toast, showToast],
  );

  const clearError = useCallback(() => setError(null), []);
  return { run, pending, error, clearError };
}
