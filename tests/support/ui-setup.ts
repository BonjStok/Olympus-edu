import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Short failure messages instead of whole DOM dumps.
configure({
  getElementError(message) {
    const error = new Error((message ?? "").split("\n\n")[0]);
    error.name = "TestingLibraryElementError";
    return error;
  },
});

// jsdom lacks a few browser APIs the app (and MAX UI) use.
beforeEach(() => {
  if (!window.matchMedia)
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  delete window.WebApp;
  history.replaceState(null, "", "/");
});
