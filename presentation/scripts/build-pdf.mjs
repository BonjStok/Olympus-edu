#!/usr/bin/env node
/**
 * Builds the «Олимпус» deck: presentation/deck.html → presentation/dist/olympus-presentation.pdf
 *
 * - every page is 1920×1080 CSS px, i.e. a 1440×810 pt PDF page (16:9), backgrounds printed;
 * - values for the «Для проверки» slide come from presentation/submission.local.json
 *   (git-ignored) or, if it does not exist, from presentation/submission.example.json;
 * - the QR code on the first slide is generated from botUrl (npx qrcode@1.5.4, from the npm
 *   cache when it is there);
 * - layout, typography (no «—», no period at the end of a paragraph, non-breaking spaces) and
 *   "no debug visuals" checks only print messages and fail the build;
 *   they never draw anything on the slides;
 * - afterwards scripts/check-pdf.py inspects the PDF itself (page size, fonts, no
 *   semi-transparent boxes) when python3 with PyMuPDF is available.
 *
 * Flags: --allow-placeholders  build even if submission values are still placeholders.
 */
import { chromium } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageChecks } from "./checks.mjs";
import { styleIssues } from "./style-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESENTATION = path.resolve(HERE, "..");
const DIST = path.join(PRESENTATION, "dist");
const SOURCE = path.join(PRESENTATION, "deck.html");
const PDF = path.join(DIST, "olympus-presentation.pdf");

const localFile = path.join(PRESENTATION, "submission.local.json");
const exampleFile = path.join(PRESENTATION, "submission.example.json");
const submissionFile = fs.existsSync(localFile) ? localFile : exampleFile;
const submission = JSON.parse(fs.readFileSync(submissionFile, "utf8"));

const placeholders = [];
(function scan(value, key = "") {
  if (typeof value === "string") {
    if (/^<[^>]+>$/.test(value.trim())) placeholders.push(`${key}: ${value}`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scan(v, key ? `${key}.${k}` : k);
  }
})(submission);

console.log(`• данные слайда «Для проверки»: ${path.relative(PRESENTATION, submissionFile)}`);
if (placeholders.length) {
  console.warn(`  ! не заполнено (${placeholders.length}):`);
  placeholders.forEach((p) => console.warn(`    - ${p}`));
}

fs.mkdirSync(DIST, { recursive: true });

// QR code for the bot link. With a placeholder link the slides show a neat empty box instead.
let qr = null;
const botUrl = String(submission.botUrl || "").trim();
if (/^https?:\/\//.test(botUrl)) {
  const out = path.join(DIST, "bot-qr.svg");
  execFileSync(
    "npx",
    [
      "--prefer-offline",
      "-y",
      "qrcode@1.5.4",
      "-t",
      "svg",
      "-e",
      "M",
      "-q",
      "0",
      "-d",
      "17202fff",
      "-l",
      "ffffffff",
      "-o",
      out,
      botUrl,
    ],
    { stdio: "ignore" },
  );
  qr = fs.readFileSync(out, "utf8").replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, "");
  console.log(`• QR-код: ${botUrl}`);
} else {
  console.warn("  ! ссылки на бота нет: вместо QR-кода будет пустая рамка");
}

let failed = false;
// Chromium blocks web fonts loaded from file:// unless file access is allowed explicitly.
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(
    ([data, svg]) => {
      window.SUBMISSION = data;
      window.BOT_QR = svg;
    },
    [submission, qr],
  );
  page.on("pageerror", (e) => {
    failed = true;
    console.error(`  ✗ ошибка на странице: ${e.message}`);
  });
  await page.goto(pathToFileURL(SOURCE).href, { waitUntil: "load" });
  await page.waitForSelector('body[data-ready="1"]');
  await page.emulateMedia({ media: "print" });
  await page.evaluate(async () => {
    const faces = ["400", "500", "600", "700"].map((w) => `${w} 32px "Inter"`);
    faces.push(...["600", "700", "800"].map((w) => `${w} 32px "Inter Display"`));
    await Promise.all(faces.map((face) => document.fonts.load(face, "Олимпус")));
    await document.fonts.ready;
  });

  const report = await page.evaluate(pageChecks);
  console.log(`• слайдов: ${report.slides}`);
  for (const w of report.warnings) console.warn(`  ! ${w}`);
  if (report.errors.length) {
    failed = true;
    console.error(`  ✗ проверки вёрстки (${report.errors.length}):`);
    report.errors.slice(0, 60).forEach((e) => console.error(`    - ${e}`));
  }

  // TEXT.md: the full text of every slide, generated from the deck on each build so it never
  //    drifts. Slide 1 and the team come from submission.local.json (passwords, names): they stay
  //    out of TEXT.md, which is committed.
  const slidesText = await page.evaluate(() => {
    // Cards, rows and list items become one line each: «501 олимпиада в календаре».
    const BLOCK =
      ".kpi, .prob, li, .aud-row, .fx, .box, .tl-i, .br .m, .ms-h, .legend, .verdict, figcaption, .lane-name, .f-row, .bar-row";
    const INLINE = new Set(["NOBR", "SUP", "A"]);
    const clean = (el) => {
      const copy = el.cloneNode(true);
      for (const sup of copy.querySelectorAll("sup.ref")) sup.textContent = ` [${sup.textContent}]`;
      for (const node of copy.querySelectorAll("*")) {
        if (INLINE.has(node.tagName)) continue;
        node.before(" ");
        node.after(" ");
      }
      return copy.textContent
        .replace(/[\s\u00a0]+/g, " ")
        .replace(/ ([,.:;)»])/g, "$1")
        .trim();
    };
    return [...document.querySelectorAll(".slide")].map((slide, i) => {
      const tab = slide.querySelector(".tabs .on")?.textContent.trim() || "";
      const title = slide.querySelector(".title");
      const lines = [];
      if (i === 0) return { tab, title: "", lines };
      const done = new Set();
      for (const el of slide.querySelectorAll(".body *")) {
        if (el.closest(".phone-body, svg, script, style, [data-team], .title, .window")) continue;
        if ([...done].some((d) => d.contains(el))) continue;
        const row = el.closest("tr, .esx-row");
        if (row) {
          done.add(row);
          const cells = [...row.children].map(clean).filter(Boolean);
          lines.push(
            row.matches(".esx-row")
              ? `${cells[0]}: ${cells.slice(1).join(" · ")}`
              : cells.join(" | "),
          );
          continue;
        }
        if (el.matches(BLOCK)) {
          done.add(el);
          lines.push(clean(el));
          continue;
        }
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const display = getComputedStyle(el).display;
        if (!own || display === "inline" || display === "contents") continue;
        done.add(el);
        lines.push(clean(el));
      }
      return { tab, title: title ? clean(title) : "", lines: lines.filter(Boolean) };
    });
  });
  const text = [
    "# Текст презентации «Олимпус»",
    "",
    "Файл собирается автоматически из `deck.html` при каждой сборке PDF (`scripts/build-pdf.mjs`),",
    "правки вносятся в `deck.html`. Сноски [N] – источники из [SOURCES.md](SOURCES.md). Слайд 1 и",
    "состав команды остаются только в локальном `submission.local.json`",
    "",
    ...slidesText.flatMap(({ tab, title, lines }, i) =>
      i === 0
        ? [
            "## 1. Техническая информация",
            "",
            "Служебный слайд: данные из `submission.local.json`",
            "",
          ]
        : [`## ${i + 1}. ${tab}`, "", `**${title}**`, "", ...lines.map((l) => `- ${l}`), ""],
    ),
  ].join("\n");
  fs.writeFileSync(path.join(PRESENTATION, "TEXT.md"), text);
  console.log("• TEXT.md обновлён");

  // Writing rules (scripts/style-rules.mjs) for every text block on the slides.
  const blocks = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".slide").forEach((slide, i) => {
      for (const el of slide.querySelectorAll("*")) {
        if (el.closest(".phone-view, svg, script, style")) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const display = getComputedStyle(el).display;
        if (!own || display === "inline" || display === "contents") continue;
        out.push([i + 1, el.textContent.replace(/\s+/g, " ").trim()]);
      }
    });
    return out;
  });
  const style = [];
  for (const [slide, text] of blocks)
    for (const issue of styleIssues(text)) style.push(`слайд ${slide}: ${issue}`);
  for (const name of ["TEXT.md", "NOTES.md"]) {
    const file = path.join(PRESENTATION, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, n) => {
      for (const issue of styleIssues(line)) style.push(`${name}:${n + 1}: ${issue}`);
      // A paragraph or list item must not end with a period (tables and code are skipped).
      const next = lines[n + 1] ?? "";
      const ends = !next.trim() || /^\s*([-*#|]|\d+\. |\*\*)/.test(next);
      if (ends && /[^.]\.$/.test(line.trimEnd()) && !/^\s*\|/.test(line))
        style.push(`${name}:${n + 1}: точка в конце абзаца или пункта`);
    });
  }
  if (style.length) {
    failed = true;
    console.error(`  ✗ правила текста (${style.length}):`);
    [...new Set(style)].slice(0, 60).forEach((e) => console.error(`    - ${e}`));
  }

  await page.pdf({
    path: PDF,
    width: "1920px",
    height: "1080px",
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    tagged: true,
    outline: true,
  });
  console.log(`• PDF: ${path.relative(process.cwd(), PDF)}`);
} finally {
  await browser.close();
}

// Inspect the PDF itself: page size, embedded fonts, no semi-transparent boxes.
const py = spawnSync("python3", [path.join(HERE, "check-pdf.py"), PDF], { stdio: "inherit" });
if (py.error || py.status === 3)
  console.warn("  ! python3 с PyMuPDF не найден: проверка PDF пропущена");
else if (py.status !== 0) failed = true;

if (placeholders.length && !process.argv.includes("--allow-placeholders")) {
  console.warn("\nPDF собран с заглушками. Для финальной версии заполните submission.local.json.");
}
if (failed) {
  console.error("\nСборка не прошла проверки");
  process.exitCode = 1;
} else {
  console.log("\nГотово без замечаний");
}
