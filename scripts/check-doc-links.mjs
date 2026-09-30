// Checks the documentation for broken links: relative links and images in Markdown files must
// point to existing files, and `#anchors` must match a heading (GitHub-style slugs). Also lists
// repository paths quoted in backticks that do not exist (warnings: they may be examples).
//
//   node scripts/check-doc-links.mjs            # README.md, docs/**/*.md, content/README.md
//   node scripts/check-doc-links.mjs file.md …  # only these files
//
// Exit code 1 when a link is broken. No dependencies.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_FILES = ["README.md", "content/README.md", ...listMarkdown("docs")];

/** @param {string} dir */
function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .map((file) => path.join(dir, file).split(path.sep).join("/"))
    .sort();
}

/** Removes fenced code blocks and inline code, keeping line numbers. */
function stripCode(/** @type {string} */ text) {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (code) => " ".repeat(code.length));
}

/** GitHub heading slug (github-slugger): lower case, punctuation removed, spaces to hyphens. */
export function slug(/** @type {string} */ heading) {
  // Inline HTML is dropped from the slug; repeat until nested fragments («<a<b>>») are gone.
  let text = heading.trim().toLowerCase();
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  }
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** Paths inside the repository quoted in backticks, e.g. `lib/server/session.ts`, `app/api/[id]/`. */
const REPO_PATH =
  /^(?:\.\/)?(?:app|bot|components|content|docs|drizzle|lib|runner|scripts|tests|public|\.github)\/[\w./[\]-]*$/;

/** @type {Map<string, Set<string>>} */
const anchorCache = new Map();

/** @param {string} file */
function anchorsOf(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set();
  const counts = new Map();
  const text = fs.readFileSync(file, "utf8").replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = slug(heading);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen ? `${base}-${seen}` : base);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** @param {string} file */
function checkFile(file) {
  const errors = [];
  const warnings = [];
  const source = fs.readFileSync(file, "utf8");
  const text = stripCode(source);
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
      const [rawPath, anchor] = target.split("#");
      const resolved = rawPath
        ? path.normalize(path.join(path.dirname(file), decodeURI(rawPath)))
        : file;
      const where = `${file}:${index + 1}`;
      if (!fs.existsSync(resolved)) {
        errors.push(`${where}: ${target} – file not found`);
        continue;
      }
      if (anchor !== undefined && resolved.endsWith(".md")) {
        if (!anchorsOf(resolved).has(decodeURIComponent(anchor)))
          errors.push(`${where}: ${target} – no heading for #${anchor}`);
      }
    }
  });
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/`([^`\s]+)`/g)) {
      const quoted = match[1].replace(/[:,.)]+$/, "");
      const looksLikePath = REPO_PATH.test(quoted);
      if (!looksLikePath || /[*<>…]|\.\.\./.test(quoted)) continue;
      if (!fs.existsSync(path.join(ROOT, quoted)))
        warnings.push(`${file}:${index + 1}: \`${quoted}\` does not exist`);
    }
  });
  return { errors, warnings };
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;
let errorCount = 0;
for (const file of files) {
  const { errors, warnings } = checkFile(file);
  for (const message of errors) console.error(`ERROR ${message}`);
  for (const message of warnings) console.warn(`warn  ${message}`);
  errorCount += errors.length;
}
console.log(`Checked ${files.length} files: ${errorCount} broken links`);
process.exit(errorCount ? 1 : 0);
