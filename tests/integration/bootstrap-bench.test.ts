// Opt-in measurement of `GET /api/olympus` for a child, one request at a time (not a load test):
//
//   OLYMPUS_BENCH=1 TEST_DATABASE_URL=… pnpm vitest run --project integration bootstrap-bench
//
// - before: the previous handler – every row parsed, complete olympiads, whole body serialised;
// - cold:   the current handler right after a content change (catalogue rebuilt);
// - cached: the current handler with the catalogue served from the isolate cache.
// CPU is this process only (Node, not workerd); PostgreSQL runs elsewhere.
import { beforeAll, describe, expect, it } from "vitest";
import { handleOlympusGet } from "@/lib/api/olympus/dispatcher";
import type { BootstrapResponse } from "@/lib/domain/types";
import { withDatabase } from "@/lib/server/db";
import { features, getEnv } from "@/lib/server/env";
import { jsonResponse } from "@/lib/server/http";
import { isMaxUser, loadSession } from "@/lib/server/session";
import { resetCatalogueCache } from "@/lib/services/catalogue";
import { listPublicSummaries } from "@/lib/services/content";
import { listProgress, progressMap } from "@/lib/services/progress";
import { configureEnv, guestToken, ORIGIN, resetDatabase } from "../support/server";
import { POST } from "@/app/api/olympus/route";

const ITERATIONS = 5;

/** The bootstrap handler as it was before the slim, cached catalogue. */
async function previousHandler(req: Request): Promise<Response> {
  const env = getEnv();
  const now = Date.now();
  return withDatabase(env, async (db) => {
    const session = await loadSession(db, req, now);
    if (!session) throw new Error("bench needs a session");
    const [records, progress] = await Promise.all([
      listPublicSummaries(db),
      listProgress(db, session.userId),
    ]);
    const flags = features(env);
    const body: BootstrapResponse = {
      records,
      progress: progressMap(progress),
      profile: { name: session.name, photo: null, max: isMaxUser(session.userId), admin: false },
      features: flags,
      sessionToken: session.token,
      serverTime: now,
      runner: flags.runner,
      maxConnected: flags.max,
    };
    return jsonResponse(body);
  });
}

interface Sample {
  cpuMs: number;
  wallMs: number;
  bytes: number;
}

async function measure(run: () => Promise<Response>): Promise<Sample> {
  const cpu = process.cpuUsage();
  const start = performance.now();
  const response = await run();
  const bytes = (await response.arrayBuffer()).byteLength;
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  expect(response.status).toBe(200);
  return { cpuMs: (used.user + used.system) / 1000, wallMs, bytes };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

describe.skipIf(!process.env.OLYMPUS_BENCH)("bootstrap benchmark", () => {
  let token: string;
  beforeAll(async () => {
    await resetDatabase({ fixtures: true });
    configureEnv();
    token = await guestToken(POST);
  });

  it("before / cold / cached", async () => {
    const request = () =>
      new Request(`${ORIGIN}/api/olympus`, { headers: { authorization: `Bearer ${token}` } });
    const cases: Record<string, () => Promise<Response>> = {
      before: () => previousHandler(request()),
      cold: () => {
        resetCatalogueCache();
        return handleOlympusGet(request());
      },
      cached: () => handleOlympusGet(request()),
    };
    const rows: Record<string, { cpuMs: string; wallMs: string; bytes: number }> = {};
    for (const [name, run] of Object.entries(cases)) {
      await measure(run); // warm-up
      const samples: Sample[] = [];
      for (let i = 0; i < ITERATIONS; i++) samples.push(await measure(run));
      rows[name] = {
        cpuMs: median(samples.map((s) => s.cpuMs)).toFixed(1),
        wallMs: median(samples.map((s) => s.wallMs)).toFixed(1),
        bytes: samples[0].bytes,
      };
    }
    // Printed directly: the test reporter hides console output of passing tests.
    process.stderr.write(
      `\nbootstrap benchmark (median of ${ITERATIONS}):\n${JSON.stringify(rows, null, 2)}\n`,
    );
  });
});
