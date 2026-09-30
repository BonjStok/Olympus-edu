/**
 * The evaluator API must answer every request with JSON: unsupported methods get a 405 with an
 * Allow header, unknown paths a 404 – never an empty body or the framework's HTML page.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { methodNotAllowed, unknownEndpoint } from "@/lib/api/v1/handler";

const ROOT = path.resolve(__dirname, "../../..");
const V1 = path.join(ROOT, "app/api/v1");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const routeFiles = fs
  .readdirSync(V1, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith("route.ts"));

describe("/api/v1 routes", () => {
  it("has a catch-all route for unknown paths", () => {
    expect(routeFiles).toContain(path.join("[...path]", "route.ts"));
  });

  it.each(routeFiles)("%s answers every HTTP method", (file) => {
    const source = fs.readFileSync(path.join(V1, file), "utf8");
    for (const method of METHODS) {
      expect(source, method).toMatch(new RegExp(`export (const|function) ${method}\\b`));
    }
  });

  it("returns a JSON 405 with Allow for unsupported methods", async () => {
    const response = await methodNotAllowed(["GET"])(new Request("http://x/api/v1/profile"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
  });

  it("returns a JSON 404 for unknown paths", async () => {
    const response = await unknownEndpoint(new Request("http://x/api/v1/nope"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
