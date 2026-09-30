// The runtime image (last stage of the Dockerfile) contains only what `COPY --from=build` puts
// there. The chat-bot (`node bot/server.mjs`) and the start-up/seed/sync scripts run from that
// image without a bundler, so every file they import – directly or through other files – must be
// copied to the same relative place, and every package they import must survive
// `pnpm prune --prod`. A missing file only shows up as a crash in the container, so it is checked
// here from the Dockerfile itself.
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY_DIRS = ["bot", "scripts"];
/** Files the runtime scripts open by a path relative to the working directory. */
const DATA_FILES = [
  "lib/seed.json", // scripts/seed.mjs, scripts/sync-content.mjs
  "drizzle/0000_postgres_init.sql", // scripts/postgres-migrate.mjs
  "bot/certs/russian_trusted_root_ca.crt", // NODE_EXTRA_CA_CERTS of the bot
  "dist/server/wrangler.json", // scripts/docker-start.mjs (build output)
  "package.json",
];

interface CopyRule {
  sources: string[];
  dest: string;
}

interface RuntimeStage {
  workdir: string;
  copies: CopyRule[];
}

/** Instructions of the Dockerfile with `\` line continuations joined and comments removed. */
function instructions(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** WORKDIR and `COPY --from=build` rules of the last stage; sources relative to the repo root. */
function runtimeStage(dockerfile: string): RuntimeStage {
  const stages: { name: string; workdir: string; lines: string[] }[] = [];
  for (const line of instructions(dockerfile)) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) stages.push({ name: from[1] ?? "", workdir: "/", lines: [] });
    else if (stages.length) stages.at(-1)!.lines.push(line);
  }
  const workdirOf = (stage: (typeof stages)[number]) => {
    let dir = "/";
    for (const line of stage.lines) {
      const match = /^WORKDIR\s+(\S+)/i.exec(line);
      if (match) dir = path.posix.resolve(dir, match[1]);
    }
    return dir;
  };
  const runtime = stages.at(-1)!;
  const workdir = workdirOf(runtime);
  const copies: CopyRule[] = [];
  for (const line of runtime.lines) {
    const match = /^COPY\s+(.*)$/i.exec(line);
    if (!match) continue;
    const words = match[1].split(/\s+/);
    const from = words.find((word) => word.startsWith("--from="))?.slice("--from=".length);
    const args = words.filter((word) => !word.startsWith("--"));
    if (!from) throw new Error(`runtime stage copies from the build context: ${line}`);
    const source = stages.find((stage) => stage.name === from);
    if (!source) throw new Error(`unknown stage ${from}: ${line}`);
    const sourceRoot = workdirOf(source);
    const dest = path.posix.resolve(workdir, args.at(-1)!);
    const sources = args.slice(0, -1).map((item) => {
      const absolute = path.posix.resolve(sourceRoot, item);
      if (!absolute.startsWith(`${sourceRoot}/`))
        throw new Error(`${item} is outside ${sourceRoot} of stage ${from}`);
      return absolute.slice(sourceRoot.length + 1).replace(/\/$/, "");
    });
    copies.push({ sources, dest: args.at(-1)!.endsWith("/") ? `${dest}/` : dest });
  }
  return { workdir, copies };
}

/**
 * Where a repository file ends up in the runtime image, or null when it is not copied. A copied
 * file goes to `dest` (or into it when there are several sources or `dest` ends with `/`); a copied
 * directory brings its contents, not the directory itself, into `dest`. Later rules win.
 */
function imagePath(stage: RuntimeStage, file: string): string | null {
  let result: string | null = null;
  for (const { sources, dest } of stage.copies) {
    const intoDir = sources.length > 1 || dest.endsWith("/");
    for (const source of sources) {
      if (file === source)
        result = intoDir ? path.posix.join(dest, path.posix.basename(source)) : dest;
      else if (file.startsWith(`${source}/`))
        result = path.posix.join(dest, file.slice(source.length + 1));
    }
  }
  return result;
}

/** Paths excluded from the build context by .dockerignore (root-anchored, `!` re-includes). */
function dockerIgnored(file: string, patterns: string[]): boolean {
  // `**/` matches any number of directories (also none), a trailing `**` everything below;
  // `*` and `?` stay within one path segment.
  const segment = (text: string) =>
    text
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
  const toRegExp = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/^\/+|\/+$/g, "")
        .split("**/")
        .map((part) => part.split("**").map(segment).join(".*"))
        .join("(?:.*/)?")}$`,
    );
  const prefixes = file.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const regexp = toRegExp(negated ? raw.slice(1) : raw);
    if (prefixes.some((prefix) => regexp.test(prefix))) ignored = !negated;
  }
  return ignored;
}

/** Module specifiers of static imports, re-exports and literal dynamic imports. */
function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /^import\s*["']([^"']+)["']/gm,
    /^import\s[\s\S]*?\sfrom\s*["']([^"']+)["']/gm,
    /^export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[\s\S]*?\})\s*from\s*["']([^"']+)["']/gm,
    /(?:await|=|return)\s+import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => path.posix.join(dir, file.split(path.sep).join("/")))
    .filter((file) => /\.(?:mjs|js)$/.test(file) && fs.statSync(file).isFile());
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
const productionPackages = new Set(Object.keys(packageJson.dependencies ?? {}));
const builtins = new Set(builtinModules);

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Everything wrong with the runtime image for the given Dockerfile: files that the bot and the
 * scripts import but that are not copied (or land somewhere else), and dev-only packages.
 */
function runtimeProblems(dockerfile: string, ignore: string[] = []): string[] {
  const stage = runtimeStage(dockerfile);
  const problems: string[] = [];
  const queue = ENTRY_DIRS.flatMap(listFiles);
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const where = imagePath(stage, file);
    if (!where) problems.push(`${file} is not copied into the runtime image`);
    if (dockerIgnored(file, ignore)) problems.push(`${file} is excluded by .dockerignore`);
    for (const specifier of importSpecifiers(fs.readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          problems.push(`${file} imports ${specifier}: ${target} does not exist`);
          continue;
        }
        const targetInImage = imagePath(stage, target);
        const expected = where && path.posix.join(path.posix.dirname(where), specifier);
        if (!targetInImage)
          problems.push(`${file} imports ${target}, which is not copied into the runtime image`);
        else if (expected && targetInImage !== expected)
          problems.push(`${file} imports ${specifier}: it is copied to ${targetInImage}`);
        queue.push(target);
      } else if (specifier.startsWith("node:") || builtins.has(specifier)) {
        continue;
      } else if (!productionPackages.has(packageName(specifier))) {
        problems.push(
          `${file} imports ${specifier}, which is not a production dependency (pnpm prune --prod)`,
        );
      }
    }
  }
  for (const file of DATA_FILES) {
    const where = imagePath(stage, file);
    if (where !== path.posix.join(stage.workdir, file))
      problems.push(`${file} must be at ${stage.workdir}/${file} in the runtime image`);
  }
  return problems;
}

const DOCKERFILE = fs.readFileSync("Dockerfile", "utf8");
const DOCKERIGNORE = fs
  .readFileSync(".dockerignore", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

describe("runtime image (Dockerfile)", () => {
  it("contains every file the bot and the scripts import, at the same relative place", () => {
    expect(runtimeProblems(DOCKERFILE, DOCKERIGNORE)).toEqual([]);
  });

  it("follows imports transitively into lib/ (shared rules and content validation)", () => {
    const stage = runtimeStage(DOCKERFILE);
    expect(stage.workdir).toBe("/app");
    for (const file of [
      "lib/domain/achievements.mjs",
      "lib/content/validate.mjs",
      "lib/content/regions.mjs",
      "bot/progress.mjs",
      "scripts/lib/pg.mjs",
    ])
      expect(imagePath(stage, file), file).toBe(`/app/${file}`);
    expect(importSpecifiers(fs.readFileSync("bot/progress.mjs", "utf8"))).toContain(
      "../lib/domain/achievements.mjs",
    );
  });

  it("reports a shared module that is imported but not copied", () => {
    const withoutRules = DOCKERFILE.replace(
      /^COPY --from=build \/app\/lib\/domain\/achievements\.mjs .*$/m,
      "",
    );
    expect(withoutRules).not.toBe(DOCKERFILE);
    expect(runtimeProblems(withoutRules)).toContain(
      "bot/progress.mjs imports lib/domain/achievements.mjs, which is not copied into the runtime image",
    );
    const withoutContent = DOCKERFILE.replace(/^COPY --from=build \/app\/lib\/content .*$/m, "");
    expect(runtimeProblems(withoutContent)).toContain(
      "scripts/sync-content.mjs imports lib/content/regions.mjs, which is not copied into the runtime image",
    );
    const withoutSeed = DOCKERFILE.replace(/^COPY --from=build \/app\/lib\/seed\.json .*$/m, "");
    expect(runtimeProblems(withoutSeed)).toContain(
      "lib/seed.json must be at /app/lib/seed.json in the runtime image",
    );
  });

  it("understands multi-source copies, directories and .dockerignore patterns", () => {
    const stage = runtimeStage(
      [
        "FROM node AS build",
        "WORKDIR /app",
        "FROM node AS runtime",
        "WORKDIR /srv",
        "COPY --from=build /app/package.json /app/pnpm-lock.yaml ./",
        "COPY --from=build /app/bot ./bot",
        "COPY --from=build /app/lib/domain/achievements.mjs \\",
        "     ./shared/achievements.mjs",
      ].join("\n"),
    );
    expect(stage.workdir).toBe("/srv");
    expect(imagePath(stage, "package.json")).toBe("/srv/package.json");
    expect(imagePath(stage, "bot/certs/x.crt")).toBe("/srv/bot/certs/x.crt");
    expect(imagePath(stage, "lib/domain/achievements.mjs")).toBe("/srv/shared/achievements.mjs");
    expect(imagePath(stage, "lib/content/validate.mjs")).toBeNull();
    expect(dockerIgnored("data/x.json", ["data"])).toBe(true);
    expect(dockerIgnored("scripts/data/x.json", ["data"])).toBe(false);
    expect(dockerIgnored("bot/app.mjs", ["**/*.mjs", "!bot/app.mjs"])).toBe(false);
    expect(dockerIgnored("bot/x.log", ["*.log"])).toBe(false);
    expect(dockerIgnored("bot/x.log", ["**/*.log"])).toBe(true);
    expect(dockerIgnored("x.log", ["**/*.log"])).toBe(true);
    expect(dockerIgnored("lib/domain/achievements.mjs", ["lib/**"])).toBe(true);
    expect(dockerIgnored("lib/domain/achievements.mjs", ["lib/*.mjs"])).toBe(false);
  });

  it("reads static, multi-line, side-effect and dynamic imports, not JSDoc type imports", () => {
    const source = [
      'import fs from "node:fs";',
      "import {",
      "  a,",
      "  b,",
      '} from "./a.mjs";',
      'import "./side-effect.mjs";',
      'export { c } from "../c.mjs";',
      'export * from "./d.mjs";',
      '/** @typedef {import("./types.mjs").T} T */',
      'const lazy = await import("./lazy.mjs");',
    ].join("\n");
    expect(importSpecifiers(source).sort()).toEqual(
      ["../c.mjs", "./a.mjs", "./d.mjs", "./lazy.mjs", "./side-effect.mjs", "node:fs"].sort(),
    );
  });
});
