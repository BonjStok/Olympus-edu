import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  errorMessage,
  isConnectivityError,
  isUnknownAction,
  normalizeBootstrap,
  parseRetryAfter,
  toApiError,
  TOKEN_KEY,
} from "@/lib/client/api";
import { friendlyError, RUNNER_DOWN } from "@/lib/client/errors";
import { createSafeStorage } from "@/lib/client/storage";

function json(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryStorage() {
  const map = new Map<string, string>();
  return createSafeStorage({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage);
}

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };

function mockFetch(...responses: (Response | Error | (() => Promise<Response>))[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init: init as Call["init"] });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

const body = (c: Call) => JSON.parse(String(c.init.body));

describe("api client", () => {
  it("posts the action with payload and parses JSON", async () => {
    const { fetchImpl, calls } = mockFetch(json(200, { ok: true, registered: true }));
    const api = createApiClient({ fetchImpl, storage: memoryStorage() });
    await expect(api.call("register", { id: "e1", yes: true })).resolves.toEqual({
      ok: true,
      registered: true,
    });
    expect(calls[0].url).toBe("/api/olympus");
    expect(calls[0].init.method).toBe("POST");
    expect(body(calls[0])).toEqual({ id: "e1", yes: true, action: "register" });
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("stores the session token and sends it as Bearer", async () => {
    const storage = memoryStorage();
    const { fetchImpl, calls } = mockFetch(
      json(200, { ok: true, sessionToken: "tok-1", startParam: "event_x" }),
      json(200, { ok: true }),
    );
    const api = createApiClient({ fetchImpl, storage });
    await expect(api.session("init-data")).resolves.toEqual({
      sessionToken: "tok-1",
      startParam: "event_x",
    });
    expect(body(calls[0])).toEqual({ action: "session", initData: "init-data" });
    expect(storage.get(TOKEN_KEY)).toBe("tok-1");
    await api.call("view-lesson", { id: "l1" });
    expect(calls[1].init.headers.Authorization).toBe("Bearer tok-1");
    // A new client picks the token up from storage (reload within the tab).
    expect(createApiClient({ fetchImpl, storage }).getToken()).toBe("tok-1");
  });

  it("switches to the rotated token after admin-login", async () => {
    const storage = memoryStorage();
    const { fetchImpl, calls } = mockFetch(
      json(200, { ok: true, sessionToken: "admin-tok" }),
      json(200, { records: [], progress: {}, profile: { admin: true } }),
    );
    const api = createApiClient({ fetchImpl, storage });
    api.setToken("guest-tok");
    await api.call("admin-login", { password: "p" });
    expect(calls[0].init.headers.Authorization).toBe("Bearer guest-tok");
    expect(storage.get(TOKEN_KEY)).toBe("admin-tok");
    const b = await api.bootstrap();
    expect(calls[1].init.headers.Authorization).toBe("Bearer admin-tok");
    expect(b.profile.admin).toBe(true);
  });

  it("quietly repeats a request whose database connection failed", async () => {
    const down = () => json(503, { error: "База данных недоступна", code: "DATABASE_UNAVAILABLE" });
    const { fetchImpl, calls } = mockFetch(down(), down(), json(200, { ok: true }), down());
    const api = createApiClient({ fetchImpl, storage: memoryStorage(), retryDelaysMs: [1, 1] });
    await expect(api.call("view-lesson", { id: "l1" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // Starting a mock twice could start two attempts: it is never repeated on its own.
    const err = await api.call("start-mock", { id: "m" }).catch((e) => e);
    expect(err).toMatchObject({ code: "DATABASE_UNAVAILABLE", action: "retry" });
    expect(calls).toHaveLength(4);
  });

  it("repeats a request the platform answered instead of the app", async () => {
    const restarted = () =>
      new Response("Your worker restarted mid-request. Please try sending the request again.", {
        status: 503,
        headers: { "Content-Type": "text/plain", "Retry-After": "0" },
      });
    const { fetchImpl, calls } = mockFetch(
      restarted(),
      json(200, { ok: true, registered: false }),
      json(503, { error: "Проверка программ не работает", code: "RUNNER_UNAVAILABLE" }),
    );
    const api = createApiClient({ fetchImpl, storage: memoryStorage(), retryDelaysMs: [1, 1] });
    await expect(api.call("register", { id: "e", yes: false })).resolves.toMatchObject({
      registered: false,
    });
    expect(calls).toHaveLength(2);
    // The app's own 503 is an answer, not a blip.
    const err = await api
      .call("run", { id: "t", code: "", language: "python", input: "" })
      .catch((e) => e);
    expect(err.code).toBe("RUNNER_UNAVAILABLE");
    expect(calls).toHaveLength(3);
  });

  it("works with the old server: no token, cookie session", async () => {
    const { fetchImpl } = mockFetch(json(200, { ok: true }));
    const api = createApiClient({ fetchImpl, storage: memoryStorage() });
    await expect(api.session()).resolves.toEqual({
      sessionToken: undefined,
      startParam: undefined,
    });
    expect(api.getToken()).toBeNull();
  });

  it("re-opens the session once after 401 and repeats the request", async () => {
    const { fetchImpl, calls } = mockFetch(
      json(401, { error: "Обновите страницу для начала сеанса" }),
      json(200, { ok: true, sessionToken: "fresh" }),
      json(200, { hint: "Подсказка" }),
    );
    const api = createApiClient({ fetchImpl, storage: memoryStorage(), getInitData: () => "init" });
    api.setToken("stale");
    await expect(api.call("hint", { id: "t" })).resolves.toEqual({ hint: "Подсказка" });
    expect(body(calls[1])).toEqual({ action: "session", initData: "init" });
    expect(calls[1].init.headers.Authorization).toBeUndefined(); // stale token dropped
    expect(calls[2].init.headers.Authorization).toBe("Bearer fresh");
  });

  it("gives up after the second 401", async () => {
    const { fetchImpl, calls } = mockFetch(
      json(401, { error: "Нет сеанса" }),
      json(200, { ok: true }),
      json(401, { error: "Нет сеанса", code: "UNAUTHORIZED" }),
    );
    const api = createApiClient({ fetchImpl, storage: memoryStorage() });
    const err = await api.call("hint", { id: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.action).toBe("reopen");
    expect(calls).toHaveLength(3);
  });

  it("maps server errors with and without a code", async () => {
    const { fetchImpl } = mockFetch(
      json(409, { error: "Сначала закончи пробник", code: "MOCK_IN_PROGRESS" }),
      json(400, { error: "Неизвестное действие" }),
      json(503, { error: "connect ECONNREFUSED 127.0.0.1:5432" }),
      new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    // Mapping only: no automatic repeats of the 5xx answers here.
    const api = createApiClient({ fetchImpl, storage: memoryStorage(), retryDelaysMs: [] });
    const e1 = await api.call("reveal", { id: "t" }).catch((e) => e);
    expect(e1).toMatchObject({ status: 409, code: "MOCK_IN_PROGRESS", action: "none" });
    // No special action needed: the server's own (human) text is shown as is.
    expect(e1.message).toBe("Сначала закончи пробник");
    const e2 = await api.call("settings", {}).catch((e) => e);
    expect(isUnknownAction(e2)).toBe(true);
    // The previous server sends unknown actions of a child's session to the admin check.
    expect(isUnknownAction(toApiError(403, { error: "Требуется вход администратора" }))).toBe(true);
    expect(isUnknownAction(toApiError(403, { error: "Нет доступа", code: "FORBIDDEN" }))).toBe(
      false,
    );
    expect(e2.code).toBe("BAD_REQUEST");
    const e3 = await api.call("hint", { id: "t" }).catch((e) => e);
    expect(e3.message).toBe("На сервере что-то пошло не так. Попробуй ещё раз через минуту");
    expect(e3.action).toBe("retry");
    const e4 = await api.call("hint", { id: "t" }).catch((e) => e);
    expect(e4).toMatchObject({ status: 502, code: "SERVER_ERROR" });
  });

  it("turns network failures and timeouts into friendly errors", async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<Response>(() => undefined);
      const hanging = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            void never();
          }),
      );
      const api = createApiClient({
        fetchImpl: hanging as unknown as typeof fetch,
        storage: memoryStorage(),
        timeoutMs: 1000,
      });
      const pending = api.call("hint", { id: "t" }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1001);
      const err = await pending;
      expect(err).toMatchObject({ status: 0, code: "TIMEOUT" });
      expect(isConnectivityError(err)).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const { fetchImpl } = mockFetch(
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
    );
    const online = createApiClient({ fetchImpl, storage: memoryStorage(), isOnline: () => true });
    const e1 = await online.call("hint", { id: "t" }).catch((e) => e);
    expect(e1).toMatchObject({
      code: "NETWORK",
      message: "Нет связи с сервером. Проверь интернет и нажми «Попробовать ещё раз»",
    });
    const offline = createApiClient({ fetchImpl, storage: memoryStorage(), isOnline: () => false });
    const e2 = await offline.call("hint", { id: "t" }).catch((e) => e);
    expect(e2.code).toBe("OFFLINE");
  });

  it("normalises bootstrap from old and new servers", async () => {
    const old = normalizeBootstrap({
      records: [],
      progress: {},
      profile: { name: "", max: false, admin: true },
      runner: true,
      maxConnected: false,
    });
    expect(old.features).toEqual({ runner: true, max: false, reminders: false, botName: null });
    expect(old.profile).toEqual({ name: null, photo: null, max: false, admin: true });
    const fresh = normalizeBootstrap({
      records: [{ id: "a" }],
      progress: [],
      features: { runner: false, max: true, reminders: true, botName: "id7700000000_bot" },
      sessionToken: "tok",
    });
    expect(fresh.features).toEqual({
      runner: false,
      max: true,
      reminders: true,
      botName: "id7700000000_bot",
    });
    expect(fresh.progress).toEqual({});
    expect(fresh.sessionToken).toBe("tok");

    const { fetchImpl, calls } = mockFetch(
      json(200, { records: [], progress: {}, sessionToken: "boot" }),
    );
    const storage = memoryStorage();
    const api = createApiClient({ fetchImpl, storage });
    const b = await api.bootstrap();
    expect(calls[0].init.method).toBe("GET");
    expect(b.features.runner).toBe(false);
    expect(storage.get(TOKEN_KEY)).toBe("boot");
  });
});

describe("error dictionary", () => {
  it("keeps the server's text unless the UI must offer something", () => {
    const invalid = toApiError(422, {
      error: "Выберите регион из списка",
      code: "INVALID_SETTINGS",
    });
    expect(invalid).toMatchObject({ message: "Выберите регион из списка", action: "none" });
    const file = toApiError(415, {
      error: "Поддерживаются PNG, JPG, WebP, PDF и MP4",
      code: "UNSUPPORTED_FILE_TYPE",
    });
    expect(file.message).toBe("Поддерживаются PNG, JPG, WebP, PDF и MP4");
    const lessons = toApiError(409, {
      error: "Сначала открой все уроки темы",
      code: "LESSONS_NOT_READ",
    });
    expect(lessons).toMatchObject({ message: "Сначала открой все уроки темы", action: "none" });
    for (const code of ["TOPIC_NOT_FOUND", "ATTEMPT_NOT_FOUND", "OLYMPIAD_NOT_FOUND", "NOT_FOUND"])
      expect(toApiError(404, { error: "Материал не найден", code })).toMatchObject({
        message: "Материал не найден",
        action: "back",
      });
  });

  it("maps codes that need an action", () => {
    expect(toApiError(401, { error: "x", code: "SESSION_EXPIRED" }).action).toBe("reopen");
    expect(toApiError(401, { error: "x", code: "MAX_AUTH_FAILED" }).action).toBe("reopen");
    expect(toApiError(403, { error: "x", code: "BAD_ORIGIN" }).action).toBe("reopen");
    expect(toApiError(403, { error: "x", code: "ADMIN_EXPIRED" }).action).toBe("login");
    expect(toApiError(403, { error: "x", code: "ADMIN_REQUIRED" }).action).toBe("login");
    expect(toApiError(403, { error: "Неверный пароль", code: "WRONG_PASSWORD" }).message).toMatch(
      /^Пароль не подошёл/,
    );
    const db = toApiError(503, {
      error: "База данных временно недоступна",
      code: "DATABASE_UNAVAILABLE",
    });
    expect(db).toMatchObject({ action: "retry" });
    expect(db.message).toMatch(/прогресс не потеряется/);
    expect(toApiError(503, { error: "x", code: "RUNNER_UNAVAILABLE" })).toMatchObject({
      message: RUNNER_DOWN,
      action: "retry",
    });
    expect(toApiError(500, { error: "Что-то пошло не так", code: "SERVER_ERROR" }).action).toBe(
      "retry",
    );
    expect(
      toApiError(503, { error: "Хранилище не подключено", code: "STORAGE_UNAVAILABLE" }),
    ).toMatchObject({ message: "Хранилище не подключено", action: "retry" });
  });

  it("uses Retry-After for rate limits and a busy checker", async () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThan(25);
    expect(parseRetryAfter(null)).toBeUndefined();
    const { fetchImpl } = mockFetch(
      new Response(JSON.stringify({ error: "Слишком много попыток входа", code: "RATE_LIMITED" }), {
        status: 429,
        headers: { "Retry-After": "600" },
      }),
      new Response(JSON.stringify({ error: "Занято", code: "RUNNER_BUSY" }), {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    );
    const api = createApiClient({ fetchImpl, storage: memoryStorage() });
    const limited = await api.call("admin-login", { password: "x" }).catch((e) => e);
    expect(limited).toMatchObject({ code: "RATE_LIMITED", retryAfter: 600 });
    expect(limited.message).toBe("Слишком много попыток подряд. Попробуйте снова через 10 минут");
    const busy = await api
      .call("check", { id: "t", code: "print(1)", language: "python" })
      .catch((e) => e);
    expect(busy).toMatchObject({ code: "RUNNER_BUSY", action: "retry" });
    expect(busy.message).toBe("Проверка программ сейчас занята. Попробуй ещё раз через 7 секунд");
  });

  it("rewrites technical server texts for children", () => {
    expect(toApiError(400, { error: "Judge0 не настроен: задайте JUDGE0_URL" }).message).toBe(
      RUNNER_DOWN,
    );
    expect(toApiError(400, { error: "Введите число, например 12 или 0,5" }).message).toBe(
      "Нужно число, например 12 или 0,5",
    );
    expect(friendlyError(400, undefined, "Какая-то новая ошибка")).toBeNull();
    expect(toApiError(400, { error: "Какая-то новая ошибка" }).message).toBe(
      "Какая-то новая ошибка",
    );
    expect(toApiError(403, {}).message).toBe("Для этого действия не хватает прав");
  });

  it("gives a Russian message for any thrown value", () => {
    expect(errorMessage(new Error("Failed to fetch"))).toBe("Не получилось. Попробуй ещё раз");
    expect(errorMessage(new Error("Что-то сломалось"))).toBe("Что-то сломалось");
    expect(errorMessage("x")).toBe("Не получилось. Попробуй ещё раз");
  });
});

describe("safe storage", () => {
  it("falls back to memory when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    const s = createSafeStorage(broken);
    s.setJSON("k", { a: 1 });
    expect(s.getJSON("k")).toEqual({ a: 1 });
    s.remove("k");
    expect(s.get("k")).toBeNull();
    s.set("bad", "{not json");
    expect(s.getJSON("bad")).toBeNull();
  });
});

describe("server clock", () => {
  it("follows the server when the device clock is off", async () => {
    const { clockOffset, serverNow, __resetClockForTests } = await import("@/lib/client/clock");
    __resetClockForTests();
    const serverTime = Date.now() + 2 * 3600_000; // the phone is 2 hours behind
    const fetchImpl = (async () =>
      new Response("{}", {
        status: 200,
        headers: { Date: new Date(serverTime).toUTCString() },
      })) as unknown as typeof fetch;
    await createApiClient({ fetchImpl, storage: memoryStorage() }).call("view-lesson", { id: "l" });
    expect(Math.abs(clockOffset() - 2 * 3600_000)).toBeLessThan(2000);
    expect(Math.abs(serverNow() - serverTime)).toBeLessThan(2000);
    const small = (async () =>
      new Response("{}", {
        status: 200,
        headers: { Date: new Date(Date.now() + 1000).toUTCString() },
      })) as unknown as typeof fetch;
    await createApiClient({ fetchImpl: small, storage: memoryStorage() }).call("view-lesson", {
      id: "l",
    });
    expect(clockOffset()).toBe(0);
    // `started` of a new attempt: the server clock is at least there.
    const { noteServerNow } = await import("@/lib/client/clock");
    noteServerNow(Date.now() - 3600_000);
    expect(clockOffset()).toBe(0);
    noteServerNow(Date.now() + 3600_000);
    expect(Math.round(clockOffset() / 1000)).toBe(3600);
    __resetClockForTests();
  });

  it("narrows the estimate with every response and tells subscribers", async () => {
    const { clockOffset, noteServerDate, subscribeClock, __resetClockForTests } =
      await import("@/lib/client/clock");
    __resetClockForTests();
    const changes = vi.fn();
    const off = subscribeClock(changes);
    const serverTime = Date.now() + 5 * 3600_000 + 250; // the phone is 5 hours behind
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ records: [], progress: {}, serverTime }), {
        status: 200,
        headers: { Date: new Date(serverTime).toUTCString() },
      })) as unknown as typeof fetch;
    await createApiClient({ fetchImpl, storage: memoryStorage() }).bootstrap();
    expect(Math.abs(clockOffset() - (5 * 3600_000 + 250))).toBeLessThan(200);
    expect(changes).toHaveBeenCalled();
    // A later whole-second Date header that agrees within its precision changes nothing.
    // (Bounds of all responses are intersected, so a quick response refines a slow one.)
    const precise = clockOffset();
    const now = Date.now();
    noteServerDate(new Date(now + precise).toUTCString(), now, now);
    expect(clockOffset()).toBe(precise);
    // …but a device clock that jumped is caught by the next response.
    noteServerDate(new Date(now + precise - 3600_000).toUTCString(), now, now);
    expect(Math.round(clockOffset() / 60_000)).toBe(Math.round((precise - 3600_000) / 60_000));
    off();
    __resetClockForTests();
  });

  it("refines a slow response with a quick one", async () => {
    const { clockOffset, noteServerTime, __resetClockForTests } =
      await import("@/lib/client/clock");
    __resetClockForTests();
    const truth = 3 * 3600_000 + 700; // server − device
    // A 3-second bootstrap: the server read its clock right at the start of it.
    noteServerTime(10_000 + truth, 10_000, 13_000);
    expect(Math.abs(clockOffset() - truth)).toBeLessThanOrEqual(1500);
    // A 40 ms request later pins it down.
    noteServerTime(20_020 + truth, 20_000, 20_040);
    expect(Math.abs(clockOffset() - truth)).toBeLessThanOrEqual(20);
    __resetClockForTests();
  });
});
