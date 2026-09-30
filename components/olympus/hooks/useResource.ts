"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isApiError } from "@/lib/client/api";
import type { ErrorAction } from "@/lib/client/errors";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  /** What to offer with the error: `back` when the thing is gone, `retry` otherwise. */
  errorAction: ErrorAction;
  loading: boolean;
  retry(): void;
}

/**
 * Loads data for a screen with loading/error/retry states.
 * `initial` (e.g. a cached copy) is shown at once; with `skip` nothing is fetched.
 */
export function useResource<T>(
  load: () => Promise<T | null>,
  options: { initial?: T | null; skip?: boolean } = {},
): Resource<T> {
  const [data, setData] = useState<T | null>(options.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<ErrorAction>("retry");
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const skip = !!options.skip;

  useEffect(() => {
    if (skip) return;
    let alive = true;
    loadRef
      .current()
      .then((d) => {
        if (!alive) return;
        if (d === null) {
          setError("Не нашли то, что ты ищешь. Попробуй начать заново");
          setErrorAction("back");
        } else setData(d);
      })
      .catch((e) => {
        if (!alive) return;
        setError(errorMessage(e));
        setErrorAction(isApiError(e) && e.action !== "none" ? e.action : "retry");
      });
    return () => {
      alive = false;
    };
  }, [skip, attempt]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  return { data, error, errorAction, loading: !skip && !data && !error, retry };
}
