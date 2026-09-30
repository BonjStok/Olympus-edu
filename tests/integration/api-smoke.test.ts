// scripts/api-smoke.mjs (the evaluator scenario from test-data.json) against the /api/v1 route
// handlers served over real HTTP, on the real content bundle.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { GET as content } from "@/app/api/v1/content/route";
import { GET as health } from "@/app/api/v1/health/route";
import { POST as lessonView } from "@/app/api/v1/lessons/[id]/view/route";
import { POST as finish } from "@/app/api/v1/mock-attempts/[id]/finish/route";
import { PATCH as save } from "@/app/api/v1/mock-attempts/[id]/route";
import { POST as startMock } from "@/app/api/v1/mocks/[id]/start/route";
import { POST as register } from "@/app/api/v1/olympiads/[id]/register/route";
import { GET as profile } from "@/app/api/v1/profile/route";
import { POST as check } from "@/app/api/v1/tasks/[id]/check/route";
import { POST as reset } from "@/app/api/v1/test/reset/route";
import { GET as topic } from "@/app/api/v1/topics/[id]/route";
import { configureEnv, resetDatabase, TEST_API_PASSWORD } from "../support/server";

type Handler = (
  req: Request,
  context?: { params?: Promise<Record<string, string>> },
) => Promise<Response>;

const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/v1\/health$/, health],
  ["POST", /^\/api\/v1\/auth\/login$/, login],
  ["POST", /^\/api\/v1\/test\/reset$/, reset],
  ["GET", /^\/api\/v1\/content$/, content],
  ["GET", /^\/api\/v1\/profile$/, profile],
  ["GET", /^\/api\/v1\/topics\/([^/]+)$/, topic],
  ["POST", /^\/api\/v1\/lessons\/([^/]+)\/view$/, lessonView],
  ["POST", /^\/api\/v1\/tasks\/([^/]+)\/check$/, check],
  ["POST", /^\/api\/v1\/olympiads\/([^/]+)\/register$/, register],
  ["POST", /^\/api\/v1\/mocks\/([^/]+)\/start$/, startMock],
  ["PATCH", /^\/api\/v1\/mock-attempts\/([^/]+)$/, save],
  ["POST", /^\/api\/v1\/mock-attempts\/([^/]+)\/finish$/, finish],
];

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await resetDatabase();
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const route = ROUTES.find(
      ([method, pattern]) => method === req.method && pattern.test(url.pathname),
    );
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":{}}');
      return;
    }
    const id = route[1].exec(url.pathname)![1];
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
    const response = await route[2](
      new Request(url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
      { params: Promise.resolve<Record<string, string>>(id ? { id: decodeURIComponent(id) } : {}) },
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => configureEnv());

function runSmoke(cwd = process.cwd()): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("scripts/api-smoke.mjs")], {
      cwd,
      env: {
        ...process.env,
        API_BASE_URL: baseUrl,
        API_WAIT_MS: "0",
        TEST_API_USERNAME: "test_user",
        TEST_API_PASSWORD,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("scripts/api-smoke.mjs", () => {
  it("passes with test-data.json: correct numeric answer and full mock score", async () => {
    const { code, output } = await runSmoke();
    expect(output).toContain("Olympus API smoke test: OK");
    expect(output).not.toContain("note:");
    expect(code).toBe(0);
  });

  it("fails loudly when an answer of test-data.json is no longer correct", async () => {
    const data = JSON.parse(fs.readFileSync("test-data.json", "utf8"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olympus-smoke-"));
    const wrongTask = { ...data, numericTask: { ...data.numericTask, correctAnswer: "100500" } };
    fs.writeFileSync(path.join(dir, "test-data.json"), JSON.stringify(wrongTask));
    const task = await runSmoke(dir);
    expect(task.code).toBe(1);
    expect(task.output).toContain(`Answer "100500" of ${data.numericTask.id} was not accepted`);

    const [first] = Object.keys(data.mockAnswers);
    const wrongMock = { ...data, mockAnswers: { ...data.mockAnswers, [first]: "100500" } };
    fs.writeFileSync(path.join(dir, "test-data.json"), JSON.stringify(wrongMock));
    const mock = await runSmoke(dir);
    expect(mock.code).toBe(1);
    expect(mock.output).toMatch(/Mock score is \d+ of \d+ with the answers of test-data.json/);
  });
});
