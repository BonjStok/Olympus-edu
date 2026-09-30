import { defineConfig, devices } from "@playwright/test";

// E2E tests run against an already started stack (docker compose up).
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  // One web container serves every browser: more parallel browsers only make it the bottleneck
  // (answers of 5–10 s on a busy machine). E2E_WORKERS overrides it.
  workers: Number(process.env.E2E_WORKERS) || 2,
  // Whole scenarios with several screens; a busy stack answers slowly, it does not fail.
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A freshly started stack can take several seconds per request under parallel runs.
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
});
