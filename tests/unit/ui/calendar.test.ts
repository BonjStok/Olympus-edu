import { describe, expect, it } from "vitest";
import type { Olympiad, OlympiadSummary } from "@/lib/domain/types";
import {
  buildCalendar,
  dayIndex,
  decodePunycodeLabel,
  DEFAULT_FILTERS,
  describeFilters,
  eventTiming,
  groupFamilies,
  initialMonth,
  inlineDetails,
  isAllRussia,
  matchesFilters,
  nextOpenEntry,
  registeredEvents,
  sectionOf,
  sourceDomain,
  splitStage,
  type CalendarFilters,
  type SeriesEntry,
} from "@/lib/ui/calendar";
import {
  eventDateLabel,
  placeLabel,
  registrationLine,
  SCHOOL_LINE,
  seriesLine,
} from "@/lib/ui/calendar-labels";
import v2 from "../../fixtures/olympiads.v2.sample.json";
import legacy from "../../fixtures/olympiads.legacy.sample.json";

const TODAY = "2026-09-29";
const V2 = v2 as unknown as Olympiad[];
const LEGACY = legacy as unknown as Olympiad[];

function event(patch: Partial<Olympiad>): Olympiad {
  return {
    id: "e",
    kind: "olympiads",
    title: "Олимпиада",
    subject: "math",
    grades: [4, 5, 6],
    format: "online",
    region: "",
    url: "https://example.ru",
    date: "2026-10-20",
    deadline: "2026-10-10",
    ...patch,
  };
}

const f = (patch: Partial<CalendarFilters> = {}): CalendarFilters => ({
  ...DEFAULT_FILTERS,
  ...patch,
});

describe("region scope (schema v2)", () => {
  it("treats an empty region as all-Russia, anything else as regional – even online", () => {
    expect(isAllRussia({ region: "" })).toBe(true);
    const online = event({ region: "Москва", format: "online" });
    expect(matchesFilters(online, f({ region: "Москва" }))).toBe(true);
    expect(matchesFilters(online, f({ region: "Псковская область" }))).toBe(false);
    expect(matchesFilters(event({}), f({ region: "Псковская область" }))).toBe(true);
  });

  it("with a region chosen shows only all-Russia events and that region (production data)", () => {
    const view = buildCalendar(V2, f({ region: "Москва" }), TODAY);
    const regions = new Set(
      view.entries.flatMap((e) => (e.kind === "event" ? [e.event.region] : ["<series>"])),
    );
    expect([...regions].sort()).toEqual(["", "Москва"]);
    const moscow = view.entries.filter((e) => e.kind === "event" && e.event.region === "Москва");
    expect(moscow).toHaveLength(V2.filter((e) => e.region === "Москва").length);
    expect(view.entries.length).toBe(V2.filter((e) => !e.region || e.region === "Москва").length);
  });

  it("the legacy online-with-region records no longer leak into other regions", () => {
    const view = buildCalendar(LEGACY, f({ region: "Псковская область" }), TODAY);
    for (const e of view.entries) {
      expect(e.kind).toBe("event");
      if (e.kind === "event") expect(["", "Псковская область"]).toContain(e.event.region);
    }
  });
});

describe("series collapsing", () => {
  it("collapses every ВсОШ series into one card when no region is chosen", () => {
    const view = buildCalendar(V2, f(), TODAY);
    const series = view.entries.filter((e): e is SeriesEntry => e.kind === "series");
    const keys = series.map((s) => s.key).sort();
    expect(keys).toEqual([
      "s:vsosh-school-2026-informatics",
      "s:vsosh-school-2026-informatics-ai",
      "s:vsosh-school-2026-informatics-infosec",
      "s:vsosh-school-2026-informatics-programming",
      "s:vsosh-school-2026-informatics-robotics",
      "s:vsosh-school-2026-math",
    ]);
    const math = series.find((s) => s.key === "s:vsosh-school-2026-math") as SeriesEntry;
    expect(math.events).toHaveLength(87);
    expect(math.regionCount).toBe(86); // НАО has a separate tour for 4th grade
    expect(math.title).toBe("ВсОШ – математика");
    expect(math.stage).toBe("школьный этап");
    expect(seriesLine(math)).toBe("школьный этап · в 86 регионах · даты зависят от региона");
    // No regional edition is shown on its own.
    expect(view.entries.some((e) => e.kind === "event" && e.event.series)).toBe(false);
  });

  it("groups the informatics profiles into one family card", () => {
    const view = buildCalendar(V2, f({ subject: "info" }), TODAY);
    const open = view.sections.find((s) => s.id === "open");
    const items = groupFamilies(open?.entries ?? []);
    const families = items.filter((i) => i.kind === "family");
    expect(families).toHaveLength(1);
    const family = families[0];
    expect(family.kind === "family" && family.title).toBe("ВсОШ – информатика");
    expect(family.kind === "family" && family.members.map((m) => m.profile).sort()).toEqual([
      "без профилей",
      "информационная безопасность",
      "искусственный интеллект",
      "программирование",
      "робототехника",
    ]);
  });

  it("falls back to title + subject when there is no series and ≥ 3 regional copies", () => {
    const view = buildCalendar(LEGACY, f(), TODAY);
    const series = view.entries.filter((e) => e.kind === "series");
    expect(series).toHaveLength(5);
    const titles = series.map((s) => (s.kind === "series" ? s.title : "")).sort();
    expect(titles).toContain("ВсОШ – математика");
    // All-Russia olympiads and one-region olympiads stay separate cards.
    const counts = new Map<string, number>();
    for (const e of LEGACY) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
    for (const e of view.entries)
      if (e.kind === "event")
        expect(!e.event.region || (counts.get(e.event.title) ?? 0) < 3).toBe(true);
  });

  it("does not collapse two regional copies without a series", () => {
    const events = ["Москва", "Псковская область"].map((region, i) =>
      event({ id: `x${i}`, title: "Турнир", region, format: "offline" }),
    );
    expect(buildCalendar(events, f(), TODAY).entries.every((e) => e.kind === "event")).toBe(true);
  });

  it("splits stage from the title", () => {
    expect(splitStage({ title: "ВсОШ – информатика: программирование – школьный этап" })).toEqual({
      title: "ВсОШ – информатика: программирование",
      stage: "школьный этап",
    });
    expect(
      splitStage({ title: "ВсОШ – математика – школьный этап", stage: "Школьный этап" }),
    ).toEqual({
      title: "ВсОШ – математика",
      stage: "школьный этап",
    });
    expect(splitStage({ title: "Турнир Ломоносова" })).toEqual({ title: "Турнир Ломоносова" });
  });

  it("splits stage from a title with em dashes (old data, text pasted from Word)", () => {
    expect(splitStage({ title: "ВсОШ \u2014 математика \u2014 школьный этап" })).toEqual({
      title: "ВсОШ \u2014 математика",
      stage: "школьный этап",
    });
  });
});

describe("timing and sections", () => {
  it("marks past events by their last day", () => {
    expect(eventTiming(event({ date: "2026-09-20" }), TODAY).past).toBe(true);
    expect(eventTiming(event({ date: "2026-09-20", dateEnd: "2026-10-05" }), TODAY).past).toBe(
      false,
    );
    expect(eventTiming(event({ date: "expected" }), TODAY).past).toBe(false);
  });

  it("closes registration after the deadline, but never for school registration", () => {
    expect(eventTiming(event({ deadline: "2026-09-28" }), TODAY).registration).toBe("closed");
    expect(
      eventTiming(event({ deadline: "2026-09-28", registrationType: "school" }), TODAY)
        .registration,
    ).toBe("open");
    expect(eventTiming(event({ registrationStart: "2026-10-05" }), TODAY).registration).toBe(
      "not-started",
    );
  });

  it("puts open registration first, closed and past last", () => {
    const events = [
      event({ id: "past", date: "2026-09-10", deadline: "2026-09-01" }),
      event({ id: "closed", deadline: "2026-09-20" }),
      event({ id: "later", deadline: "2026-10-15", date: "2026-10-25" }),
      event({ id: "soon", deadline: "2026-10-01", date: "2026-10-02" }),
      event({ id: "tbd", date: "expected", deadline: "expected" }),
      event({
        id: "notyet",
        registrationStart: "2026-11-01",
        deadline: "2026-11-10",
        date: "2026-11-20",
      }),
      event({ id: "star", featured: true, deadline: "2026-10-18", date: "2026-10-19" }),
    ];
    const view = buildCalendar(events, f(), TODAY);
    expect(view.sections.map((s) => s.id)).toEqual(["open", "soon", "tbd", "closed", "past"]);
    const ids = (id: string) =>
      view.sections.find((s) => s.id === id)?.entries.map((e) => e.key) ?? [];
    expect(ids("open")).toEqual(["star", "soon", "later"]);
    expect(ids("soon")).toEqual(["notyet"]);
    expect(ids("tbd")).toEqual(["tbd"]);
    expect(ids("closed")).toEqual(["closed"]);
    expect(ids("past")).toEqual(["past"]);
    expect(sectionOf(eventTiming(events[0], TODAY))).toBe("past");
  });

  it("the month grid shows the same set as the list, with deadlines", () => {
    const events = [
      event({ id: "a", date: "2026-10-20", deadline: "2026-10-10" }),
      event({ id: "b", date: "2026-10-20", deadline: "2026-10-20" }),
    ];
    const view = buildCalendar(events, f(), TODAY);
    const days = dayIndex(view.entries);
    expect(days.get("2026-10-20")?.events.map((e) => e.key)).toEqual(["a", "b"]);
    expect(days.get("2026-10-10")?.deadlines.map((e) => e.key)).toEqual(["a"]);
    expect(days.has("2026-09-29")).toBe(false);
  });

  it("opens the grid on the current month unless it is empty", () => {
    const view = buildCalendar([event({ date: "2026-11-20", deadline: "2026-11-10" })], f(), TODAY);
    expect(initialMonth(view.entries, TODAY)).toEqual({ year: 2026, month: 10 });
    const withThisMonth = buildCalendar([event({ date: "2026-09-30" })], f(), TODAY);
    expect(initialMonth(withThisMonth.entries, TODAY)).toEqual({ year: 2026, month: 8 });
  });

  it("finds the most urgent open olympiad for «Главная»", () => {
    const next = nextOpenEntry(V2, f({ grade: 5, subject: "math", region: "Москва" }), TODAY);
    expect(next?.timing.past).toBe(false);
    expect(next && sectionOf(next.timing)).toBe("open");
  });

  it("lists the child's olympiads, upcoming first", () => {
    const events = [
      event({ id: "old", date: "2026-09-01" }),
      event({ id: "late", date: "2026-12-01" }),
      event({ id: "early", date: "2026-10-01" }),
    ];
    const progress = {
      "registration:old": { registered: true },
      "registration:late": { registered: true },
      "registration:early": { registered: true },
    };
    expect(registeredEvents(events, progress, TODAY).map((r) => r.event.id)).toEqual([
      "early",
      "late",
      "old",
    ]);
  });
});

describe("labels", () => {
  it("school registration has no deadline line", () => {
    const e = event({ registrationType: "school", deadline: undefined });
    expect(registrationLine(e, eventTiming(e, TODAY), 2026).text).toBe(SCHOOL_LINE);
  });

  it("says how many days are left", () => {
    const e = event({ deadline: "2026-10-12" });
    expect(registrationLine(e, eventTiming(e, TODAY), 2026)).toEqual({
      text: "Регистрация до 12 октября · осталось 13 дней",
      tone: "ok",
    });
    const urgent = event({ deadline: "2026-09-30" });
    expect(registrationLine(urgent, eventTiming(urgent, TODAY), 2026)).toEqual({
      text: "Регистрация до 30 сентября · остался 1 день",
      tone: "warn",
    });
  });

  it("describes where the olympiad happens", () => {
    expect(placeLabel({ region: "", format: "online" })).toBe("Онлайн · вся Россия");
    expect(placeLabel({ region: "", format: "offline" })).toBe("Очно · по всей России");
    expect(placeLabel({ region: "Москва", format: "online" })).toBe("Онлайн · Москва");
    expect(placeLabel({ region: "Москва", format: "offline" })).toBe("Очно · Москва");
  });

  it("formats dates and ranges", () => {
    expect(eventDateLabel({ date: "expected" })).toBe("Ожидается");
    expect(eventDateLabel({ date: "2026-10-20", dateEnd: "2026-11-10" }, 2026, true)).toBe(
      "20 окт – 10 нояб",
    );
  });

  it("describes the filters honestly", () => {
    expect(describeFilters(f({ grade: 5, subject: "math", region: "Москва" }))).toBe(
      "5 класс · математика · Москва и вся Россия",
    );
    expect(describeFilters(f())).toBe("все классы · все регионы");
  });

  it("shows readable source domains, decoding punycode", () => {
    expect(sourceDomain("https://www.olimpiada.ru/activity/45")).toBe("olimpiada.ru");
    expect(sourceDomain("https://xn--h1aamv.xn--p1ai/news/")).toBe("тиим.рф");
    expect(decodePunycodeLabel("xn--80ajbshivpvn")).toBe("центркафел");
    expect(sourceDomain("not a url")).toBeUndefined();
  });

  it("tells complete olympiads (older server, teacher) from catalogue summaries", () => {
    const summary: OlympiadSummary = {
      id: "o",
      kind: "olympiads",
      title: "Олимпиада",
      subject: "math",
      grades: [5],
      format: "online",
      region: "",
      url: "https://example.ru/reg",
      date: "expected",
    };
    expect(inlineDetails(summary)).toBeNull();
    const full: Olympiad = {
      ...summary,
      description: "Описание",
      source: "https://olimpiada.ru/activity/1",
      verifiedAt: "2026-09-20",
      image: "https://example.ru/picture.png",
    };
    expect(inlineDetails(full)).toEqual({
      description: "Описание",
      source: "https://olimpiada.ru/activity/1",
      verifiedAt: "2026-09-20",
      image: "https://example.ru/picture.png",
    });
    // The calendar stores `image: ""`: still a complete record, just without a picture.
    expect(inlineDetails({ ...summary, image: "" } as Olympiad)).toEqual({
      description: undefined,
      source: undefined,
      verifiedAt: undefined,
      image: "",
    });
  });
});
