"use client";
import { useEffect, useRef, useState } from "react";
import { serverNow, subscribeClock } from "@/lib/client/clock";

/**
 * Milliseconds left until `endsAt` by the server clock, ticking once per second. `onExpire`
 * fires once when the time is up (also when the page was reopened after the deadline) and
 * again only if time "comes back" first – e.g. the server clock estimate showed that the
 * device clock had jumped ahead.
 */
export function useCountdown(
  endsAt: number | null,
  onExpire?: () => void,
  now: () => number = serverNow,
): number {
  const [left, setLeft] = useState(() => (endsAt ? Math.max(0, endsAt - now()) : 0));
  const expired = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  useEffect(() => {
    expired.current = false;
    if (!endsAt) return;
    const tick = () => {
      const ms = Math.max(0, endsAt - now());
      setLeft(ms);
      if (ms > 0) expired.current = false;
      else if (!expired.current) {
        expired.current = true;
        onExpireRef.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    const offClock = subscribeClock(tick);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      offClock();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [endsAt, now]);

  return left;
}
