// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "@/lib/client/max-bridge";

function fakeWebApp(platform: "ios" | "android" | "web" | "desktop" | null = "ios") {
  const back: (() => void)[] = [];
  const wa = {
    initData: platform ? "query_id=1&hash=abc" : "",
    initDataUnsafe: { start_param: "event_vsosh-msk" },
    platform,
    ready: vi.fn(),
    openLink: vi.fn(),
    openMaxLink: vi.fn(),
    enableClosingConfirmation: vi.fn(),
    disableClosingConfirmation: vi.fn(),
    shareMaxContent: vi.fn(async () => ({ status: "shared" })),
    getLaunchContext: vi.fn(async () => ({ entryPoint: "tabbar" as const })),
    BackButton: {
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn((cb: () => void) => back.push(cb)),
      offClick: vi.fn((cb: () => void) => back.splice(back.indexOf(cb), 1)),
    },
    HapticFeedback: {
      impactOccurred: vi.fn(async () => ({})),
      // MAX Web rejects unsupported methods – the wrapper must swallow it.
      notificationOccurred: vi.fn(() =>
        Promise.reject({ error: { code: "client.unsupported_method" } }),
      ),
      selectionChanged: vi.fn(async () => ({})),
    },
  };
  window.WebApp = wa as unknown as typeof window.WebApp;
  return { wa, back };
}

describe("max bridge", () => {
  beforeEach(() => bridge.__resetBridgeForTests());
  afterEach(() => {
    delete window.WebApp;
    vi.restoreAllMocks();
  });

  it("is inert outside MAX", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    expect(bridge.isInsideMax()).toBe(false);
    expect(bridge.platform()).toBeNull();
    bridge.ready();
    bridge.haptic.success();
    bridge.setClosingConfirmation(true);
    expect(bridge.showBackButton(() => undefined)).toBeTypeOf("function");
    expect(await bridge.shareToMax({ text: "x" })).toBe(false);
    expect(await bridge.launchEntryPoint()).toBeNull();
    bridge.openExternal("https://olimpiada.ru");
    expect(open).toHaveBeenCalledWith("https://olimpiada.ru", "_blank", "noopener,noreferrer");
  });

  it("the script without launch data (plain browser) counts as outside MAX", () => {
    fakeWebApp(null);
    expect(bridge.isInsideMax()).toBe(false);
  });

  it("reads launch data and the deep link", () => {
    fakeWebApp("android");
    expect(bridge.isInsideMax()).toBe(true);
    expect(bridge.isMobileMax()).toBe(true);
    expect(bridge.initData()).toBe("query_id=1&hash=abc");
    expect(bridge.startParam()).toBe("event_vsosh-msk");
  });

  it("waits for MAX to finish providing initData", async () => {
    const { wa } = fakeWebApp("android");
    wa.initData = "";
    window.setTimeout(() => {
      wa.initData = "query_id=late&hash=abc";
    }, 5);

    await expect(bridge.waitForInitData({ timeoutMs: 100, pollMs: 5 })).resolves.toBe(
      "query_id=late&hash=abc",
    );
  });

  it("waits for the MAX bridge itself on a cold launch", async () => {
    window.setTimeout(() => {
      fakeWebApp("android");
      window.WebApp!.initData = "query_id=bridge&hash=abc";
    }, 5);

    await expect(bridge.waitForInitData({ timeoutMs: 100, pollMs: 5 })).resolves.toBe(
      "query_id=bridge&hash=abc",
    );
  });

  it("gives a plain browser a guest fallback after the bounded wait", async () => {
    await expect(bridge.waitForInitData({ timeoutMs: 0 })).resolves.toBeUndefined();
  });

  it("captures WebAppData from the launch URL before the router touches the hash", () => {
    bridge.captureLaunchParams({
      hash: "#WebAppData=query_id%3D7&WebAppPlatform=web",
      search: "?WebAppStartParam=tab_mocks",
    });
    expect(bridge.initData()).toBe("query_id=7");
    expect(bridge.startParam()).toBe("tab_mocks");
  });

  it("calls ready() once", () => {
    const { wa } = fakeWebApp();
    bridge.ready();
    bridge.ready();
    expect(wa.ready).toHaveBeenCalledTimes(1);
  });

  it("opens links through MAX: max.ru links inside MAX, others in the browser", () => {
    const { wa } = fakeWebApp();
    bridge.openExternal("https://olimpiada.ru/activity/45");
    bridge.openExternal("https://max.ru/olympus_bot?startapp=tab_calendar");
    expect(wa.openLink).toHaveBeenCalledWith("https://olimpiada.ru/activity/45");
    expect(wa.openMaxLink).toHaveBeenCalledWith("https://max.ru/olympus_bot?startapp=tab_calendar");
  });

  it("uses haptics on phones only and never leaks rejections", async () => {
    const { wa } = fakeWebApp("ios");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    bridge.haptic.success();
    bridge.haptic.selection();
    bridge.haptic.impact("medium");
    await new Promise((r) => setTimeout(r, 0));
    expect(wa.HapticFeedback.notificationOccurred).toHaveBeenCalledWith("success");
    expect(wa.HapticFeedback.impactOccurred).toHaveBeenCalledWith("medium");
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);

    const web = fakeWebApp("web").wa;
    bridge.haptic.error();
    expect(web.HapticFeedback.notificationOccurred).not.toHaveBeenCalled();
  });

  it("shows the BackButton and unsubscribes", () => {
    const { wa, back } = fakeWebApp();
    const onBack = vi.fn();
    const off = bridge.showBackButton(onBack);
    expect(wa.BackButton.show).toHaveBeenCalled();
    back[0]();
    expect(onBack).toHaveBeenCalled();
    off();
    expect(wa.BackButton.offClick).toHaveBeenCalledWith(onBack);
    bridge.hideBackButton();
    expect(wa.BackButton.hide).toHaveBeenCalled();
  });

  it("toggles closing confirmation", () => {
    const { wa } = fakeWebApp();
    bridge.setClosingConfirmation(true);
    bridge.setClosingConfirmation(false);
    expect(wa.enableClosingConfirmation).toHaveBeenCalledTimes(1);
    expect(wa.disableClosingConfirmation).toHaveBeenCalledTimes(1);
  });

  it("shares results and reads the launch context", async () => {
    const { wa } = fakeWebApp("android");
    expect(bridge.canShareToMax()).toBe(true);
    await expect(
      bridge.shareToMax({ text: "7 из 10", link: "https://max.ru/bot?startapp=mock_m1" }),
    ).resolves.toBe(true);
    expect(wa.shareMaxContent).toHaveBeenCalledWith({
      text: "7 из 10",
      link: "https://max.ru/bot?startapp=mock_m1",
    });
    await expect(bridge.launchEntryPoint()).resolves.toBe("tabbar");
    wa.shareMaxContent.mockRejectedValueOnce(new Error("timeout"));
    await expect(bridge.shareToMax({ text: "x" })).resolves.toBe(false);
  });

  it("builds mini-app deep links only for valid bot names and payloads", () => {
    expect(bridge.miniAppLink("id7700_bot", "mock_m1")).toBe(
      "https://max.ru/id7700_bot?startapp=mock_m1",
    );
    expect(bridge.miniAppLink(undefined, "mock_m1")).toBeUndefined();
    expect(bridge.miniAppLink("bad name", "x")).toBeUndefined();
    expect(bridge.miniAppLink("bot", "a b")).toBeUndefined();
  });
});
