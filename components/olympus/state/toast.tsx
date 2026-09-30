"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success(text: string): void;
  error(text: string, action?: ToastItem["action"]): void;
  info(text: string, action?: ToastItem["action"]): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ToastListContext = createContext<ToastItem[]>([]);

const DURATION: Record<ToastKind, number> = { success: 3500, info: 5000, error: 7000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((list) => list.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string, action?: ToastItem["action"]) => {
      const id = nextId.current++;
      setItems((list) => {
        // The same message twice in a row is shown once.
        const rest = list.filter((x) => x.text !== text).slice(-2);
        return [...rest, { id, kind, text, action }];
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION[kind] + (action ? 3000 : 0)),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (text) => push("success", text),
      error: (text, action) => push("error", text, action),
      info: (text, action) => push("info", text, action),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      <ToastListContext.Provider value={items}>{children}</ToastListContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

export function useToastItems(): ToastItem[] {
  return useContext(ToastListContext);
}
