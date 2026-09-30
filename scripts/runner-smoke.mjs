const runnerUrl = String(process.env.RUNNER_URL || "http://localhost:8080").replace(/\/$/, "");
const token = process.env.RUNNER_TOKEN;
if (!token) throw new Error("Set RUNNER_TOKEN before running pnpm test:runner");

const health = await fetch(runnerUrl + "/health", { signal: AbortSignal.timeout(10000) });
if (!health.ok) throw new Error(`Runner health failed: ${health.status} ${await health.text()}`);

const response = await fetch(runnerUrl + "/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    language: "python",
    code: "n = int(input())\nprint(n * 2)",
    tests: [{ input: "2\n", output: "4" }],
  }),
  signal: AbortSignal.timeout(30000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok)
  throw new Error(`Runner execute failed: ${response.status} ${JSON.stringify(body)}`);
if (body.correct !== true)
  throw new Error(`Runner returned incorrect result: ${JSON.stringify(body)}`);
console.log("Olympus runner smoke test: OK");
