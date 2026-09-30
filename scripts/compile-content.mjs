// Validates `content/**` and writes the seed bundle `lib/seed.json`.
// Validation rules are shared with the admin publish/import path (lib/content/validate.mjs).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { regions } from "../lib/content/regions.mjs";
import {
  ContentValidationError,
  RECORD_KINDS,
  findDuplicateOlympiad,
  validateLinks,
  validateRecord,
} from "../lib/content/validate.mjs";

/** @typedef {import("../lib/domain/types").ContentRecord} ContentRecord */

/**
 * Reads every `<contentDir>/<kind>/**.json` file (top-level files first, then `imports/`),
 * validates the records and returns them in a stable order.
 * @param {{ contentDir?: string; regions?: readonly string[] }} [options]
 * @returns {ContentRecord[]}
 */
export function compileContent(options = {}) {
  const contentDir = options.contentDir ?? "content";
  const regionList = options.regions ?? regions;
  /** @type {Map<string, { record: ContentRecord; source: string }>} */
  const records = new Map();

  for (const kind of RECORD_KINDS) {
    const dir = path.join(contentDir, kind);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.split(path.sep).join("/"))
      .sort((a, b) => Number(a.includes("/")) - Number(b.includes("/")) || a.localeCompare(b));

    for (const file of files) {
      const source = path.join(dir, file);
      let items;
      try {
        items = JSON.parse(fs.readFileSync(source, "utf8"));
      } catch (error) {
        throw new Error(
          `${source}: ошибка JSON: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
      if (!Array.isArray(items)) items = [items];
      const idsInFile = new Set();
      for (const item of items) {
        let record;
        try {
          record = validateRecord(item, { regions: regionList, kind });
        } catch (error) {
          throw new Error(`${source}: ${error instanceof Error ? error.message : error}`, {
            cause: error,
          });
        }
        if (idsInFile.has(record.id)) throw new Error(`${source}: повтор ID ${record.id}`);
        idsInFile.add(record.id);
        const previous = records.get(record.id);
        if (previous && previous.record.kind !== kind)
          throw new Error(
            `${source}: ID ${record.id} уже используется в разделе ${previous.record.kind}`,
          );
        records.set(record.id, { record, source });
      }
    }
  }

  const all = [...records.values()].map((entry) => entry.record);
  const sourceOf = (/** @type {string} */ id) => records.get(id)?.source ?? id;
  try {
    validateLinks(all, new Map());
  } catch (error) {
    if (error instanceof ContentValidationError && error.recordId)
      throw new Error(`${sourceOf(error.recordId)}: ${error.message}`, { cause: error });
    throw error;
  }
  const duplicate = findDuplicateOlympiad(
    /** @type {import("../lib/domain/types").Olympiad[]} */ (
      all.filter((record) => record.kind === "olympiads")
    ),
  );
  if (duplicate)
    throw new Error(
      `${sourceOf(duplicate.record.id)}: олимпиада ${duplicate.record.id} повторяет ` +
        `${duplicate.duplicateOf.id} (${sourceOf(duplicate.duplicateOf.id)}): ` +
        "совпадают название, регион и дата",
    );
  return all;
}

function main() {
  const records = compileContent();
  fs.writeFileSync("lib/seed.json", JSON.stringify(records));
  console.log(`Compiled and validated ${records.length} content records`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
