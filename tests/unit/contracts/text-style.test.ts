/**
 * House style for every human-facing text (docs, README, learning content, UI, bot): short dashes
 * only, no template rhetoric, and no talking about the hackathon organisers as a third party.
 * Official region names keep their em dash (they are identifiers shared with production data).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const HUMAN_TEXT =
  /^(README\.md|docs\/.+\.md|content\/.+\.(json|md)|bot\/texts\.mjs|components\/.+\.tsx|lib\/client\/errors\.ts|lib\/ui\/.+\.ts|\.env\.example)$/;
const files = tracked.filter(
  (file) => HUMAN_TEXT.test(file) && fs.existsSync(path.join(ROOT, file)),
);

// Official names of federal subjects that contain an em dash.
const REGION_NAMES = [
  "Кемеровская область — Кузбасс",
  "Ханты-Мансийский автономный округ — Югра",
  "Республика Северная Осетия — Алания",
  "Чувашская Республика — Чувашия",
];

const TEMPLATE_PHRASES: [string, RegExp][] = [
  ["«это не просто»", /это не просто\s/i],
  ["«о чём никто не говорит»", /о ч[её]м (никто не|не) говор/i],
  ["«будущее уже здесь»", /будущее уже (здесь|наступило)/i],
  ["«давайте разберёмся»", /давайте разбер[её]мся/i],
  ["«важно понимать»", /важно понимать/i],
  ["«стоит отметить»", /стоит отметить/i],
  ["«не секрет, что»", /не секрет,? что/i],
  ["«меняет правила игры»", /меня(ет|ют) правила игры/i],
  ["«на новый уровень»", /на новый уровень/i],
  ["«по-настоящему»", /по-настоящему/i],
  ["«правда в том, что»", /правда в том,? что/i],
  ["«это только начало»", /это только начало/i],
  ["«не просто X, а Y»", /не просто [а-яё]+(?: [а-яё]+)?, а /i],
  ["«Это не X. Это Y»", /(^|[.!?]\s+)Это не [^.!?\n]{1,60}\.\s+Это /],
  ["рекламные эпитеты", /революционн|инновационн|бесшовн/i],
  ["«мощный инструмент»", /мощн(ый|ая|ое|ые|ого|ым) (инструмент|решени|платформ|функционал)/i],
  ["«под капотом»", /под капотом/i],
  ["«из коробки»", /из коробки(?!\s+в\s)/i],
  ["«ключ к успеху»", /ключ(ом)? к успеху/i],
  ["«открывает двери»", /открыва[а-яё]+ (новые )?двери/i],
  ["«экосистема»", /экосистем/i],
  ["«сердце системы»", /сердц[еа] (систем|приложени|проект|сервис)/i],
  ["«путь героя»", /путь героя/i],
  ["«следует подчеркнуть»", /(следует|стоит) подчеркнуть/i],
  ["«в мире, где»", /в мире,? где/i],
  ["«как известно»", /как известно/i],
  ["«по сути»", /по сути(?! дела)/i],
  ["«В целом,»", /(^|[.!?]\s+)В целом,/],
  ["«суперсила»", /суперсил/i],
  ["«главный секрет»", /главный секрет/i],
  ["«самое время»", /самое время/i],
  ["«магия»", /(^|[^а-яё])маги(я|ей|ю)([^а-яё]|$)/i],
  [
    "организаторы хакатона как третья сторона",
    /(от|у) организаторов хакатона|выда(ют|ли|ёт) организатор|токен[а-я]* организатор/i,
  ],
];

// Documentation (README, docs, content/README): subject + verb + fact, without intensifiers
// and figurative filler. Learning content may use «действительно» in proofs, so it is not checked.
const DOCS = /^(README\.md|docs\/.+\.md|content\/README\.md)$/;
const DOC_PHRASES: [string, RegExp][] = [
  ["«действительно»", /действительно(?![а-яё])/i],
  ["«реально»", /(^|[^а-яё])реально/i],
  ["«абсолютно»", /абсолютно/i],
  ["«на самом деле»", /на самом деле/i],
  ["«прямо в/из/внутри»", /прямо (в|из|внутри) /i],
  ["«зелёный CI»", /зелён[а-яё]* CI/i],
];

function read(file: string) {
  let text = fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const name of REGION_NAMES) text = text.split(name).join("");
  return text;
}

describe("human-facing text style", () => {
  it("covers the expected files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses short dashes only", () => {
    const offenders = files.filter((file) => read(file).includes("—"));
    expect(offenders).toEqual([]);
  });

  it.each(TEMPLATE_PHRASES)("has no %s", (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("checks every documentation file", () => {
    expect(files.filter((file) => DOCS.test(file)).length).toBeGreaterThan(10);
  });

  it.each(DOC_PHRASES)("documentation has no %s", (_label, pattern) => {
    const offenders = files.filter((file) => DOCS.test(file) && pattern.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
