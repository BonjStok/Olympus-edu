/** Region search for the region combobox: case/ё-insensitive, word starts, common aliases. */

const ALIASES: Record<string, string> = {
  мск: "Москва",
  москва: "Москва",
  спб: "Санкт-Петербург",
  питер: "Санкт-Петербург",
  петербург: "Санкт-Петербург",
  ленинград: "Ленинградская область",
  подмосковье: "Московская область",
  кузбасс: "Кемеровская область — Кузбасс",
  якутия: "Республика Саха (Якутия)",
  башкирия: "Республика Башкортостан",
  татарстан: "Республика Татарстан",
  чувашия: "Чувашская Республика",
  удмуртия: "Удмуртская Республика",
  осетия: "Республика Северная Осетия — Алания",
  хмао: "Ханты-Мансийский автономный округ — Югра",
  янао: "Ямало-Ненецкий автономный округ",
  крым: "Республика Крым",
};

export function normalizeQuery(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[()«»"]/g, " ")
      // Hyphen, en dash and em dash (\u2014 stays in official names such as «Кемеровская область — Кузбасс»).
      .replace(/[\s\u00a0\u2013\u2014-]+/g, " ")
      .trim()
  );
}

/**
 * Regions matching the query, best matches first:
 * alias → name starts with the query → a word starts with it → contains it.
 */
export function searchRegions(query: string, regions: readonly string[]): string[] {
  const q = normalizeQuery(query);
  if (!q) return [...regions];
  const scored: { region: string; score: number }[] = [];
  const alias = Object.entries(ALIASES).find(([k]) => k.startsWith(q) && q.length >= 3)?.[1];
  for (const region of regions) {
    const n = normalizeQuery(region);
    let score = -1;
    if (alias && region === alias) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.split(" ").some((w) => w.startsWith(q))) score = 2;
    else if (n.includes(q)) score = 3;
    if (score >= 0) scored.push({ region, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.region);
}

/**
 * Region names in the data sometimes carry an extra official suffix
 * («Чувашская Республика — Чувашия»); treat it as the same region.
 */
export function sameRegion(eventRegion: string, chosen: string): boolean {
  const a = normalizeQuery(eventRegion);
  const b = normalizeQuery(chosen);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + " ") || b.startsWith(a + " ");
}
