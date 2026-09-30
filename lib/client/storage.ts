/**
 * Web Storage that never throws: storage can be disabled (private mode, sandboxed or
 * `credentialless` iframes in MAX Web) – the app must keep working in memory.
 */
export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  getJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): void;
}

type StorageKind = "localStorage" | "sessionStorage";

function resolve(kind: StorageKind): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window[kind] ?? null;
  } catch {
    return null;
  }
}

export function createSafeStorage(kind: StorageKind | Storage | null): SafeStorage {
  const memory = new Map<string, string>();
  const backend = (): Storage | null => (typeof kind === "string" ? resolve(kind) : kind);
  const api: SafeStorage = {
    get(key) {
      try {
        const v = backend()?.getItem(key);
        if (v !== null && v !== undefined) return v;
      } catch {
        /* fall through to memory */
      }
      return memory.get(key) ?? null;
    },
    set(key, value) {
      memory.set(key, value);
      try {
        backend()?.setItem(key, value);
      } catch {
        /* storage full or blocked: memory copy is enough */
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        backend()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    getJSON<T>(key: string) {
      const raw = api.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    setJSON(key, value) {
      api.set(key, JSON.stringify(value));
    },
  };
  return api;
}

export const localStore = createSafeStorage("localStorage");
export const sessionStore = createSafeStorage("sessionStorage");
