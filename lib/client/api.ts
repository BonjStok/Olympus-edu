/**
 * Typed client for the `/api/olympus` RPC (see `OlympusRpc` in `lib/domain/types.ts`).
 *
 * - Auth: the session token is kept in memory and in sessionStorage and sent as
 *   `Authorization: Bearer`; without a token the server falls back to its cookie.
 * - On 401 the client re-opens the session once (with MAX `initData` when available)
 *   and repeats the request.
 * - Every failure becomes an `ApiError` with a message that can be shown to a child.
 * - Works with the previous server as well: `features`, `sessionToken` and error `code`
 *   are optional in responses.
 */
import type {
  AdminRecord,
  Features,
  OlympusAction,
  OlympusRpc,
  Profile,
  ProgressMap,
  RecordSummary,
} from "@/lib/domain/types";
import { noteServerDate, noteServerTime } from "./clock";
import { friendlyError, type ErrorAction } from "./errors";
import { createSafeStorage, type SafeStorage } from "./storage";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** What the UI should offer: «Попробовать ещё раз», «Открыть заново», вход учителя, «Назад». */
  readonly action: ErrorAction;
  /** The server's own text before it was made child-friendly. */
  readonly serverMessage: string;
  /** Seconds from the `Retry-After` header (429, 503), when the server sent it. */
  readonly retryAfter?: number;
  /** The app itself answered with an error `code` (not a proxy or the platform). */
  readonly appAnswered: boolean;
  constructor(
    status: number,
    code: string,
    message: string,
    action: ErrorAction = "none",
    serverMessage = message,
    retryAfter?: number,
    appAnswered = false,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.action = action;
    this.serverMessage = serverMessage;
    this.retryAfter = retryAfter;
    this.appAnswered = appAnswered;
  }
}

export const MESSAGES = {
  network: "Нет связи с сервером. Проверь интернет и нажми «Попробовать ещё раз»",
  offline: "Похоже, пропал интернет. Подключись к сети и нажми «Попробовать ещё раз»",
  timeout: "Сервер долго не отвечает. Попробуй ещё раз через минуту",
  unauthorized: "Сеанс закончился. Закрой Олимпус и открой снова – прогресс сохранён",
  forbidden: "Для этого действия не хватает прав",
  notFound: "Не нашли этот материал. Возможно, его убрали",
  rateLimited: "Слишком много попыток подряд. Подожди несколько минут и попробуй снова",
  server: "На сервере что-то пошло не так. Попробуй ещё раз через минуту",
  generic: "Не получилось. Попробуй ещё раз",
} as const;

function defaultCode(status: number): string {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "ERROR";
}

function defaultMessage(status: number): string {
  if (status === 401) return MESSAGES.unauthorized;
  if (status === 403) return MESSAGES.forbidden;
  if (status === 404) return MESSAGES.notFound;
  if (status === 429) return MESSAGES.rateLimited;
  if (status >= 500) return MESSAGES.server;
  return MESSAGES.generic;
}

const CYRILLIC = /[а-яё]/i;

/** Seconds of a `Retry-After` header (delta-seconds or an HTTP date). */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

/** Maps a non-2xx response body to an ApiError with a human Russian message. */
export function toApiError(status: number, body: unknown, retryAfter?: number): ApiError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
  const raw = typeof b.error === "string" ? b.error.trim() : "";
  const rawCode = typeof b.code === "string" && b.code ? b.code : undefined;
  const friendly = friendlyError(status, rawCode, raw, retryAfter);
  // Technical (non-Russian) texts from infrastructure errors are replaced by a friendly one.
  const message = friendly?.message ?? (raw && CYRILLIC.test(raw) ? raw : defaultMessage(status));
  const action = friendly?.action ?? (status >= 500 ? "retry" : "none");
  return new ApiError(
    status,
    rawCode ?? defaultCode(status),
    message,
    action,
    raw,
    retryAfter,
    !!rawCode,
  );
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/**
 * The action is not supported by this server. The previous server answers unknown actions
 * with 400 «Неизвестное действие» – or, for a non-teacher session, with
 * 403 «Требуется вход администратора» (unknown actions fell through to the admin check).
 * Only use it for actions that never need a teacher (`settings`, `mock-get`, …).
 */
export function isUnknownAction(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.code === "UNKNOWN_ACTION") return true;
  if (e.status === 400 && /неизвестное действие/i.test(e.serverMessage)) return true;
  return (
    e.status === 403 &&
    e.code === "FORBIDDEN" &&
    /требуется вход администратора/i.test(e.serverMessage)
  );
}

/** Connectivity problems deserve a banner; everything else is shown next to its control. */
export function isConnectivityError(e: unknown): boolean {
  return isApiError(e) && ["NETWORK", "OFFLINE", "TIMEOUT"].includes(e.code);
}

/** Any error → text for a toast or banner. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error && CYRILLIC.test(e.message)) return e.message;
  return MESSAGES.generic;
}

export interface Bootstrap {
  records: RecordSummary[] | AdminRecord[];
  progress: ProgressMap;
  profile: Profile;
  features: Features;
}

interface RawBootstrap {
  records?: unknown;
  progress?: unknown;
  profile?: Partial<Profile> | null;
  features?: Partial<Features> | null;
  sessionToken?: unknown;
  runner?: unknown;
  maxConnected?: unknown;
}

export function normalizeBootstrap(raw: unknown): Bootstrap & { sessionToken?: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawBootstrap;
  const f = r.features ?? {};
  return {
    records: (Array.isArray(r.records) ? r.records : []) as RecordSummary[] | AdminRecord[],
    progress:
      r.progress && typeof r.progress === "object" && !Array.isArray(r.progress)
        ? (r.progress as ProgressMap)
        : {},
    profile: {
      name: typeof r.profile?.name === "string" && r.profile.name ? r.profile.name : null,
      photo: null,
      max: !!r.profile?.max,
      admin: !!r.profile?.admin,
    },
    features: {
      runner: typeof f.runner === "boolean" ? f.runner : !!r.runner,
      max: typeof f.max === "boolean" ? f.max : !!r.maxConnected,
      reminders: typeof f.reminders === "boolean" ? f.reminders : false,
      botName: typeof f.botName === "string" && f.botName ? f.botName : null,
    },
    sessionToken: typeof r.sessionToken === "string" && r.sessionToken ? r.sessionToken : undefined,
  };
}

export interface SessionResult {
  sessionToken?: string;
  /** Signed `start_param` echoed by the server after validating `initData`. */
  startParam?: string;
}

export interface CallOptions {
  timeoutMs?: number;
  /** Lets the request finish while the page unloads (code drafts, mock answers). */
  keepalive?: boolean;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Where the session token survives reloads within a tab. */
  storage?: SafeStorage;
  timeoutMs?: number;
  /** MAX `initData`, used to re-open the session after a 401. */
  getInitData?: () => string | undefined;
  isOnline?: () => boolean;
  /** Pauses before repeating a request that hit a transient failure; one retry per entry. */
  retryDelaysMs?: readonly number[];
}

export const TOKEN_KEY = "olympus.sessionToken";

/**
 * Actions that are not repeated automatically when it is unclear whether the first request was
 * handled: a second `start-mock` would start a second attempt, `admin-login` has already rotated
 * the token, `upload` would store the file twice.
 */
const NO_AUTO_RETRY: ReadonlySet<string> = new Set(["start-mock", "admin-login", "upload"]);

/**
 * The request did not get an answer from the app: its database connection failed (nothing was
 * done yet), or the platform in front of it answered instead – the worker restarted, the proxy
 * lost the upstream (502/503/504 without the app's `code`).
 */
export function isTransientFailure(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.code === "DATABASE_UNAVAILABLE") return true;
  return [502, 503, 504].includes(e.status) && e.code === "SERVER_ERROR" && !e.appAnswered;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createApiClient(options: ApiClientOptions = {}) {
  const endpoint = options.endpoint ?? "/api/olympus";
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);
  const storage = options.storage ?? createSafeStorage("sessionStorage");
  const defaultTimeout = options.timeoutMs ?? 20_000;
  const isOnline =
    options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  let token: string | null = storage.get(TOKEN_KEY);
  let reauth: Promise<SessionResult> | null = null;

  function setToken(next: string | null | undefined) {
    token = next || null;
    if (token) storage.set(TOKEN_KEY, token);
    else storage.remove(TOKEN_KEY);
  }

  async function request(
    method: "GET" | "POST",
    body: unknown,
    opts: CallOptions = {},
    /** Local send/receive time of the response (to place the server's `serverTime`). */
    onTiming?: (sentAt: number, receivedAt: number) => void,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs ?? defaultTimeout);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    const sentAt = Date.now();
    try {
      res = await doFetch(endpoint, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        keepalive: opts.keepalive,
      });
    } catch {
      if (timedOut) throw new ApiError(0, "TIMEOUT", MESSAGES.timeout, "retry");
      if (opts.signal?.aborted) throw new ApiError(0, "ABORTED", "Действие отменено");
      if (!isOnline()) throw new ApiError(0, "OFFLINE", MESSAGES.offline, "retry");
      throw new ApiError(0, "NETWORK", MESSAGES.network, "retry");
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    const receivedAt = Date.now();
    noteServerDate(res.headers?.get?.("date"), sentAt, receivedAt);
    onTiming?.(sentAt, receivedAt);
    let data: unknown;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok)
      throw toApiError(res.status, data, parseRetryAfter(res.headers?.get?.("retry-after")));
    return data;
  }

  async function session(initData?: string): Promise<SessionResult> {
    const data = (await request(
      "POST",
      initData ? { action: "session", initData } : { action: "session" },
    )) as {
      sessionToken?: unknown;
      startParam?: unknown;
    } | null;
    const result: SessionResult = {
      sessionToken: typeof data?.sessionToken === "string" ? data.sessionToken : undefined,
      startParam:
        typeof data?.startParam === "string" && data.startParam ? data.startParam : undefined,
    };
    if (result.sessionToken) setToken(result.sessionToken);
    return result;
  }

  /** Re-opens the session once for all concurrent 401s. */
  function reopenSession(): Promise<SessionResult> {
    if (!reauth) {
      setToken(null);
      reauth = session(options.getInitData?.()).finally(() => {
        reauth = null;
      });
    }
    return reauth;
  }

  async function withAuthRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(isApiError(e) && e.status === 401)) throw e;
      await reopenSession();
      return run();
    }
  }

  const retryDelays = options.retryDelaysMs ?? [500, 1500];

  /**
   * A short blip (see `isTransientFailure`) is retried quietly instead of making the child
   * press «Попробовать ещё раз».
   */
  async function withTransientRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (e) {
        if (!isTransientFailure(e) || attempt >= retryDelays.length) throw e;
        const asked = Math.min(5, (e as ApiError).retryAfter ?? 0) * 1000;
        await sleep(Math.max(retryDelays[attempt], asked));
      }
    }
  }

  async function call<A extends OlympusAction>(
    action: A,
    payload: OlympusRpc[A]["req"],
    opts?: CallOptions,
  ): Promise<OlympusRpc[A]["res"]> {
    const send = () =>
      request("POST", { ...(payload as object), action }, opts) as Promise<OlympusRpc[A]["res"]>;
    if (action === "session") return withTransientRetry(send);
    const res = NO_AUTO_RETRY.has(action)
      ? await withAuthRetry(send)
      : await withTransientRetry(() => withAuthRetry(send));
    // `admin-login` rotates the session: the old token stops working right away.
    const rotated = (res as { sessionToken?: unknown } | null)?.sessionToken;
    if (typeof rotated === "string" && rotated) setToken(rotated);
    return res;
  }

  async function bootstrap(opts?: CallOptions): Promise<Bootstrap> {
    let sent = 0;
    let received = 0;
    const raw = await withTransientRetry(() =>
      withAuthRetry(() =>
        request("GET", undefined, opts, (a, b) => {
          sent = a;
          received = b;
        }),
      ),
    );
    const serverTime = (raw as { serverTime?: unknown } | null)?.serverTime;
    if (typeof serverTime === "number") noteServerTime(serverTime, sent, received);
    const { sessionToken, ...rest } = normalizeBootstrap(raw);
    if (sessionToken) setToken(sessionToken);
    return rest;
  }

  return {
    call,
    bootstrap,
    session,
    getToken: () => token,
    setToken,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
