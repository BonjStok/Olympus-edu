import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Vitest runs outside workerd, so the `cloudflare:workers` virtual module is
// replaced by a shim whose `env` falls back to process.env (see tests/support).
export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      "cloudflare:workers": path.join(root, "tests/support/cloudflare-workers.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.{ts,tsx}"],
          environment: "node",
          // Integration suites share one PostgreSQL database.
          fileParallelism: false,
          setupFiles: ["tests/support/integration-setup.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "ui",
          include: ["tests/ui/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["tests/support/ui-setup.ts"],
          // Whole screens rendered in jsdom and typed into with userEvent take ~1-3 s; on a busy
          // CI runner or laptop the default 5 s limit turns that into random timeouts.
          testTimeout: 15_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "app/**",
        "bot/**",
        "components/**",
        "db/**",
        "hooks/**",
        "lib/**",
        "runner/**",
        "scripts/**",
      ],
      exclude: ["lib/seed.json", "**/*.d.ts"],
      reporter: ["text-summary", "html", "lcov"],
    },
  },
});
