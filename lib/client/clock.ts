/**
 * Server time estimate. Mock timers and «today» must follow the server (it finishes attempts by
 * its own clock), while a child's device clock can be minutes or hours off – or be changed while
 * the app is open.
 *
 * Every API response bounds the offset `server − device`: the server read its clock somewhere
 * between the moment the request was sent and the moment the response arrived. Bounds of all
 * responses are intersected (like NTP), so a slow response (the big bootstrap) is refined by the
 * next quick one. A response that contradicts the bounds means the device clock was changed:
 * the estimate starts over from that response.
 *
 * Sources: `serverTime` of the bootstrap (milliseconds), the HTTP `Date` header of every
 * response (whole seconds), `started` of a mock attempt the server has just created.
 * Screens subscribe with `subscribeClock` to re-render when the estimate changes.
 */
import { sessionStore } from "./storage";

const KEY = "olympus.clockOffset";
/** A device clock within this of the server is treated as exact (no jitter in timers). */
const EXACT_MS = 1000;

let offset = Number(sessionStore.get(KEY)) || 0;
/** What is known about `server − device` in this page (not stored: rebuilt on reload). */
let lower = -Infinity;
let upper = Infinity;
const listeners = new Set<() => void>();

function setOffset(next: number) {
  const value = Math.round(next);
  if (value === offset) return;
  offset = value;
  sessionStore.set(KEY, String(offset));
  listeners.forEach((listener) => listener());
}

/** The offset is somewhere in [min, max]. */
function observe(min: number, max: number) {
  if (!(min <= max)) return;
  const lo = Math.max(lower, min);
  const hi = Math.min(upper, max);
  if (lo > hi) {
    // Contradicts everything seen before: the device clock was changed. Start over.
    lower = min;
    upper = max;
  } else {
    lower = lo;
    upper = hi;
  }
  if (lower - EXACT_MS <= 0 && 0 <= upper + EXACT_MS) return setOffset(0);
  if (!Number.isFinite(lower)) return setOffset(upper);
  if (!Number.isFinite(upper)) return setOffset(lower);
  setOffset((lower + upper) / 2);
}

/** `Date` header of a response sent at `sentAt` and received at `receivedAt` (local ms). */
export function noteServerDate(
  header: string | null | undefined,
  sentAt: number,
  receivedAt: number,
) {
  if (!header) return;
  const seconds = Date.parse(header);
  if (!Number.isFinite(seconds) || !(receivedAt >= sentAt)) return;
  // The header drops milliseconds: the server clock read [D, D + 1 s) during the request.
  observe(seconds - receivedAt, seconds + 999 - sentAt);
}

/** Precise server time (ms) read while a request sent at `sentAt` was in flight. */
export function noteServerTime(serverMs: number, sentAt: number, receivedAt: number) {
  if (!Number.isFinite(serverMs) || serverMs <= 0 || !(receivedAt >= sentAt)) return;
  observe(serverMs - receivedAt, serverMs - sentAt);
}

/** A server timestamp from the past, e.g. `started` of an attempt created by this request. */
export function noteServerNow(serverMs: number) {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  // The server has read this time before «now»: its clock is at least that far along.
  observe(serverMs - Date.now(), Infinity);
}

export function serverNow(): number {
  return Date.now() + offset;
}

export function clockOffset(): number {
  return offset;
}

/** Called whenever the estimate changes; returns the unsubscribe function. */
export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetClockForTests(): void {
  offset = 0;
  lower = -Infinity;
  upper = Infinity;
  sessionStore.remove(KEY);
}
