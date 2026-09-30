"use client";
/**
 * Navigation state (tab + nested screen stack) synced with `location.hash`:
 * browser Back, the MAX BackButton and in-app «Назад» all walk the same history.
 * A screen can register a leave guard (running mock, unsaved editor) that asks first.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import * as bridge from "@/lib/client/max-bridge";
import {
  ADMIN_HOME,
  INITIAL_NAV,
  fromHash,
  navReducer,
  parentOf,
  toHash,
  type NavState,
  type Screen,
  type Tab,
} from "@/lib/ui/navigation";

/** Returns true when it blocked the transition (and will call `proceed` itself if allowed). */
export type LeaveGuard = (proceed: () => void) => boolean;

export interface NavApi {
  state: NavState;
  screen: Screen | undefined;
  go(tab: Tab): void;
  push(screen: Screen): void;
  /** Replaces the top screen without a new history entry (e.g. next lesson). */
  replace(screen: Screen): void;
  /** Resets the whole state, e.g. from a deep link. */
  reset(state: NavState, mode?: "push" | "replace"): void;
  back(): void;
  setGuard(guard: LeaveGuard | null): void;
}

const NavContext = createContext<NavApi | null>(null);

interface HistoryState {
  olympus: true;
  depth: number;
}

function historyDepth(): number {
  const s = (typeof history !== "undefined" ? history.state : null) as HistoryState | null;
  return s && s.olympus ? s.depth : 0;
}

function initialState(): NavState {
  if (typeof location === "undefined") return INITIAL_NAV;
  return fromHash(location.hash) ?? INITIAL_NAV;
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(navReducer, undefined, initialState);
  const stateRef = useRef(state);
  const guardRef = useRef<LeaveGuard | null>(null);
  const scrollPositions = useRef(new Map<string, number>());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** Hash of the history entry at each depth, to know whether Back lands on the parent. */
  const entries = useRef<string[]>([]);

  const commit = useCallback((next: NavState, mode: "push" | "replace", restoreScroll = false) => {
    const prevHash = toHash(stateRef.current);
    scrollPositions.current.set(prevHash, window.scrollY);
    const hash = toHash(next);
    if (hash !== location.hash) {
      if (mode === "push") {
        const depth = historyDepth() + 1;
        history.pushState({ olympus: true, depth } satisfies HistoryState, "", hash);
        entries.current = [...entries.current.slice(0, depth), hash];
      } else {
        const depth = historyDepth();
        history.replaceState({ olympus: true, depth } satisfies HistoryState, "", hash);
        entries.current[depth] = hash;
      }
    }
    stateRef.current = next;
    dispatch({ type: "set", state: next });
    const y = restoreScroll ? (scrollPositions.current.get(hash) ?? 0) : 0;
    requestAnimationFrame(() => window.scrollTo({ top: y }));
  }, []);

  /** Runs `action` unless the guard blocks it; the guard may run it later. */
  const guarded = useCallback((action: () => void) => {
    const guard = guardRef.current;
    if (
      guard &&
      guard(() => {
        guardRef.current = null;
        action();
      })
    )
      return;
    action();
  }, []);

  // Normalise the URL on start (drops MAX launch params from the hash).
  useEffect(() => {
    const depth = historyDepth();
    const hash = toHash(stateRef.current);
    history.replaceState({ olympus: true, depth } satisfies HistoryState, "", hash);
    entries.current[depth] = hash;
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = fromHash(location.hash) ?? INITIAL_NAV;
      entries.current[historyDepth()] = location.hash;
      const current = stateRef.current;
      if (toHash(next) === toHash(current)) return;
      const guard = guardRef.current;
      if (guard) {
        const blocked = guard(() => {
          guardRef.current = null;
          commit(next, "push", true);
        });
        if (blocked) {
          // Put the current screen back into the URL until the guard decides.
          const depth = historyDepth() + 1;
          history.pushState({ olympus: true, depth } satisfies HistoryState, "", toHash(current));
          entries.current = [...entries.current.slice(0, depth), toHash(current)];
          return;
        }
      }
      commit(next, "replace", true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [commit]);

  const back = useCallback(() => {
    guarded(() => {
      const current = stateRef.current;
      const parent = parentOf(current);
      if (!parent) {
        if (current.tab !== "home") commit({ tab: "home", stack: [] }, "push");
        return;
      }
      const depth = historyDepth();
      if (depth > 0 && entries.current[depth - 1] === toHash(parent)) history.back();
      else commit(parent, "replace", true);
    });
  }, [commit, guarded]);

  const api = useMemo<NavApi>(
    () => ({
      state,
      screen: state.stack[state.stack.length - 1],
      go: (tab) =>
        guarded(() => {
          const cur = stateRef.current;
          if (cur.tab === tab && (!cur.stack.length || tab === "admin")) {
            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }
          commit(tab === "admin" ? ADMIN_HOME : { tab, stack: [] }, "push");
        }),
      push: (screen) =>
        guarded(() =>
          commit({ ...stateRef.current, stack: [...stateRef.current.stack, screen] }, "push"),
        ),
      replace: (screen) => {
        const cur = stateRef.current;
        commit({ ...cur, stack: [...cur.stack.slice(0, -1), screen] }, "replace");
      },
      reset: (next, mode = "push") => guarded(() => commit(next, mode)),
      back,
      setGuard: (guard) => {
        guardRef.current = guard;
      },
    }),
    [state, commit, guarded, back],
  );

  // MAX BackButton: visible on nested screens only.
  const nested = state.stack.length > 0 || state.tab === "admin";
  useEffect(() => {
    if (!nested) {
      bridge.hideBackButton();
      return;
    }
    const off = bridge.showBackButton(() => back());
    return off;
  }, [nested, back]);

  return <NavContext.Provider value={api}>{children}</NavContext.Provider>;
}

export function useNav(): NavApi {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav outside NavigationProvider");
  return ctx;
}

/** Registers a leave guard while `active` is true. */
export function useLeaveGuard(active: boolean, guard: LeaveGuard): void {
  const { setGuard } = useNav();
  const guardRef = useRef(guard);
  useEffect(() => {
    guardRef.current = guard;
  });
  useEffect(() => {
    if (!active) return;
    setGuard((proceed) => guardRef.current(proceed));
    return () => setGuard(null);
  }, [active, setGuard]);
}
