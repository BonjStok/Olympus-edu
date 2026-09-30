/**
 * Safe wrapper over MAX Bridge (`window.WebApp`, loaded by
 * `<script src="https://st.max.ru/js/max-web-app.js">` in `app/layout.tsx`).
 *
 * Only APIs confirmed by the MAX docs (or by the library source for `ready()`) are used.
 * Outside MAX every call is a no-op or a browser fallback, and Promise-based calls never
 * reject: MAX Web rejects unsupported methods, so haptics run on iOS/Android only.
 */

export type MaxPlatform = "ios" | "android" | "desktop" | "web";

type BridgePromise<T = unknown> = Promise<T>;

export interface WebAppLike {
  initData?: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string; last_name?: string } };
  platform?: MaxPlatform | null;
  version?: string;
  ready?: () => void;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  shareMaxContent?: (p: { text?: string; link?: string }) => BridgePromise<{ status?: string }>;
  getLaunchContext?: () => BridgePromise<{ entryPoint?: "tabbar" | "default" }>;
  BackButton?: {
    show?: () => void;
    hide?: () => void;
    onClick?: (cb: () => void) => void;
    offClick?: (cb: () => void) => void;
  };
  HapticFeedback?: {
    impactOccurred?: (style: "soft" | "light" | "medium" | "heavy" | "rigid") => BridgePromise;
    notificationOccurred?: (type: "error" | "success" | "warning") => BridgePromise;
    selectionChanged?: () => BridgePromise;
  };
}

declare global {
  interface Window {
    WebApp?: WebAppLike;
  }
}

/** `WebAppData` from the launch URL, captured before the router rewrites the hash. */
let launchInitData: string | undefined;
let launchStartParam: string | undefined;

/** Call once at startup, before touching `location.hash`. */
export function captureLaunchParams(loc: Pick<Location, "hash" | "search"> = location): void {
  try {
    const hash = new URLSearchParams(loc.hash.replace(/^#\/?/, ""));
    const search = new URLSearchParams(loc.search);
    launchInitData = hash.get("WebAppData") || undefined;
    launchStartParam =
      search.get("WebAppStartParam") ||
      hash.get("WebAppStartParam") ||
      search.get("startapp") ||
      undefined;
  } catch {
    /* malformed URL: nothing to capture */
  }
}

export function webApp(): WebAppLike | null {
  if (typeof window === "undefined") return null;
  return window.WebApp ?? null;
}

/** Opened inside a MAX client (the bridge knows its platform or has launch data). */
export function isInsideMax(): boolean {
  const wa = webApp();
  return !!wa && (!!wa.platform || !!wa.initData);
}

export function platform(): MaxPlatform | null {
  return webApp()?.platform ?? null;
}

export function isMobileMax(): boolean {
  const p = platform();
  return p === "ios" || p === "android";
}

export function initData(): string | undefined {
  return webApp()?.initData || launchInitData || undefined;
}

/**
 * MAX Android can create `window.WebApp` before it fills `initData`.  Do not turn a
 * real MAX user into a guest simply because that small handshake is still running.
 *
 * A normal browser has no bridge at all, so it is not delayed.  The wait is bounded:
 * opening the site directly must still work as a guest if MAX never supplies data.
 */
export async function waitForInitData(
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string | undefined> {
  const immediate = initData();
  if (immediate || !webApp()) return immediate;

  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_500);
  const pollMs = Math.max(10, options.pollMs ?? 50);
  const until = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      const value = initData();
      if (value || Date.now() >= until) return resolve(value);
      window.setTimeout(check, pollMs);
    };
    check();
  });
}

export function startParam(): string | undefined {
  return webApp()?.initDataUnsafe?.start_param || launchStartParam || undefined;
}

let readySent = false;
/** Tells MAX the first meaningful screen is rendered (hides the host spinner). Once. */
export function ready(): void {
  if (readySent || !isInsideMax()) return;
  readySent = true;
  try {
    webApp()?.ready?.();
  } catch {
    /* host without ready(): harmless */
  }
}

const MAX_LINK = /^https:\/\/(?:[\w-]+\.)?max\.ru\//i;

/**
 * Opens an external link. Must be called synchronously inside a click handler:
 * MAX checks for a user gesture. `https://max.ru/…` links open inside MAX.
 */
export function openExternal(url: string): void {
  const wa = webApp();
  if (wa && isInsideMax()) {
    try {
      if (MAX_LINK.test(url) && wa.openMaxLink) wa.openMaxLink(url);
      else if (wa.openLink) wa.openLink(url);
      else window.open(url, "_blank", "noopener,noreferrer");
      return;
    } catch {
      /* fall back to the browser */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function quiet(p: unknown): void {
  if (p && typeof (p as Promise<unknown>).catch === "function")
    (p as Promise<unknown>).catch(() => undefined);
}

/** Vibration feedback. MAX supports it on iOS and Android only. */
export const haptic = {
  success: () => notify("success"),
  error: () => notify("error"),
  warning: () => notify("warning"),
  selection() {
    if (!isMobileMax()) return;
    try {
      quiet(webApp()?.HapticFeedback?.selectionChanged?.());
    } catch {
      /* ignore */
    }
  },
  impact(style: "soft" | "light" | "medium" | "heavy" | "rigid" = "light") {
    if (!isMobileMax()) return;
    try {
      quiet(webApp()?.HapticFeedback?.impactOccurred?.(style));
    } catch {
      /* ignore */
    }
  },
};

function notify(type: "error" | "success" | "warning") {
  if (!isMobileMax()) return;
  try {
    quiet(webApp()?.HapticFeedback?.notificationOccurred?.(type));
  } catch {
    /* ignore */
  }
}

/** Shows the native Back button and subscribes to it; returns the cleanup. */
export function showBackButton(onBack: () => void): () => void {
  const bb = webApp()?.BackButton;
  if (!bb || !isInsideMax()) return () => undefined;
  try {
    bb.onClick?.(onBack);
    bb.show?.();
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      bb.offClick?.(onBack);
    } catch {
      /* ignore */
    }
  };
}

export function hideBackButton(): void {
  const bb = webApp()?.BackButton;
  if (!bb || !isInsideMax()) return;
  try {
    bb.hide?.();
  } catch {
    /* ignore */
  }
}

/** Asks for confirmation before MAX closes the mini-app (running mock test). */
export function setClosingConfirmation(enabled: boolean): void {
  const wa = webApp();
  if (!wa || !isInsideMax()) return;
  try {
    if (enabled) wa.enableClosingConfirmation?.();
    else wa.disableClosingConfirmation?.();
  } catch {
    /* ignore */
  }
}

export function canShareToMax(): boolean {
  return isInsideMax() && typeof webApp()?.shareMaxContent === "function";
}

/** Shares text (and an optional max.ru deep link) to a MAX chat. Needs a user gesture. */
export async function shareToMax(content: { text: string; link?: string }): Promise<boolean> {
  const wa = webApp();
  if (!wa?.shareMaxContent || !isInsideMax()) return false;
  try {
    const res = await wa.shareMaxContent(content.link ? content : { text: content.text });
    return res?.status === "shared";
  } catch {
    return false;
  }
}

/** Where MAX launched the app from; `null` when unknown/unsupported (web, old clients). */
export async function launchEntryPoint(): Promise<"tabbar" | "default" | null> {
  if (!isMobileMax()) return null;
  try {
    const res = await webApp()?.getLaunchContext?.();
    return res?.entryPoint ?? null;
  } catch {
    return null;
  }
}

/** Deep link to the mini-app for sharing, when the bot name is configured at build time. */
export function miniAppLink(botName: string | undefined, payload: string): string | undefined {
  if (!botName || !/^[\w-]+$/.test(botName) || !/^[\w-]{1,512}$/.test(payload)) return undefined;
  return `https://max.ru/${botName}?startapp=${payload}`;
}

/** Test hook: resets module state between tests. */
export function __resetBridgeForTests(): void {
  readySent = false;
  launchInitData = undefined;
  launchStartParam = undefined;
}
