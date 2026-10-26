import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/domain/types";
import { readSeedBundle } from "../../scripts/seed.mjs";

const migration = fs.readFileSync("drizzle/0004_task_replacements_20261026.sql", "utf8");
const payload = [
  ...migration.matchAll(/\$task_release_json\$([\s\S]*?)\$task_release_json\$/g),
].map((match) => JSON.parse(match[1]) as Task);
const before = JSON.parse(
  fs.readFileSync("tests/fixtures/tasks.before-2026-10-26.json", "utf8"),
) as Task[];
const reviewed = Object.keys(
  JSON.parse(fs.readFileSync("docs/task-replacement/reviewed.json", "utf8")),
).sort();

describe("frozen task release", () => {
  it("contains exactly the ten reviewed replacements and agrees with the compiled bundle", () => {
    expect(payload.map((task) => task.id).sort()).toEqual(reviewed);
    expect(payload).toHaveLength(10);
    const compiled = new Map(readSeedBundle().map((record) => [record.id, record]));
    for (const task of payload) expect(task).toEqual(compiled.get(task.id));
  });

  it("keeps task identities, types and learning paths compatible with stored progress and mocks", () => {
    const previous = new Map(before.map((task) => [task.id, task]));
    expect(previous.size).toBe(10);
    for (const task of payload) {
      const old = previous.get(task.id)!;
      expect(task).not.toEqual(old);
      for (const key of ["kind", "type", "topicId", "grade", "subject", "order"] as const)
        expect(task[key], `${task.id}: ${key}`).toEqual(old[key]);
    }
  });
});
