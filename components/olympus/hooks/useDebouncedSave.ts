"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/**
 * Debounced autosave with a guaranteed flush: on unmount (navigation), when the page is
 * hidden or unloaded the last value is sent at once with `keepalive`.
 */
export function useDebouncedSave<T>(
  save: (value: T, opts: { keepalive: boolean }) => Promise<unknown>,
  delay = 800,
) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  const alive = useRef(true);
  useEffect(() => {
    saveRef.current = save;
  });

  const flush = useCallback(async (keepalive = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const item = pending.current;
    if (!item) return;
    pending.current = null;
    if (alive.current) setStatus("saving");
    try {
      await saveRef.current(item.value, { keepalive });
      if (alive.current) setStatus(pending.current ? "pending" : "saved");
    } catch {
      // Keep the value to retry with the next change or flush.
      if (!pending.current) pending.current = item;
      if (alive.current) setStatus("error");
    }
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      setStatus("pending");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  useEffect(() => {
    alive.current = true;
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    const onPageHide = () => void flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      alive.current = false;
      void flush(true);
    };
  }, [flush]);

  return { schedule, flush, status, hasPending: () => !!pending.current };
}
