/**
 * Navigation model: a bottom-bar tab plus a stack of nested screens.
 * The state is mirrored into `location.hash` so that browser Back, the MAX BackButton
 * and shared links all work, e.g. `#/calendar/event/max-2026`.
 */
import type { RecordKind, StartParam } from "@/lib/domain/types";

/** Child sections in the tab bar. */
export const TABS = ["home", "calendar", "learn", "mocks", "profile"] as const;
export type ChildTab = (typeof TABS)[number];
/** `admin` is the teacher's area: own navigation, not in the tab bar. */
export type Tab = ChildTab | "admin";

export type LegalDoc = "privacy" | "terms" | "about";
export type TopicPart = "theory" | "practice";

export type Screen =
  | { name: "event"; id: string }
  /** One topic: theory lessons or practice tasks; `step` is 0-based. */
  | { name: "topic"; id: string; part: TopicPart; step: number }
  | { name: "attempt"; id: string }
  | { name: "legal"; doc: LegalDoc }
  /** Teacher's list of records of one kind (base screen of the admin area). */
  | { name: "admin"; kind: RecordKind }
  /** `id === "new"` for a new record. */
  | { name: "admin-edit"; kind: RecordKind; id: string };

export interface NavState {
  tab: Tab;
  stack: Screen[];
}

export type NavAction =
  | { type: "tab"; tab: Tab }
  | { type: "push"; screen: Screen }
  | { type: "replace"; screen: Screen }
  | { type: "pop" }
  | { type: "set"; state: NavState };

export const INITIAL_NAV: NavState = { tab: "home", stack: [] };
export const ADMIN_HOME: NavState = { tab: "admin", stack: [{ name: "admin", kind: "olympiads" }] };

export const RECORD_KINDS: readonly RecordKind[] = [
  "olympiads",
  "topics",
  "lessons",
  "tasks",
  "mock-tests",
];
const LEGAL: readonly LegalDoc[] = ["privacy", "terms", "about"];

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "tab":
      return action.tab === "admin" ? ADMIN_HOME : { tab: action.tab, stack: [] };
    case "push":
      return { ...state, stack: [...state.stack, action.screen] };
    case "replace":
      return { ...state, stack: [...state.stack.slice(0, -1), action.screen] };
    case "pop":
      return { ...state, stack: state.stack.slice(0, -1) };
    case "set":
      return action.state;
  }
}

/** Where «Назад» leads from this state (null – nowhere, it is a root). */
export function parentOf(state: NavState): NavState | null {
  if (state.tab === "admin") {
    if (state.stack.length > 1) return { ...state, stack: state.stack.slice(0, -1) };
    return { tab: "profile", stack: [] };
  }
  if (!state.stack.length) return null;
  return { ...state, stack: state.stack.slice(0, -1) };
}

export function currentScreen(state: NavState): Screen | undefined {
  return state.stack[state.stack.length - 1];
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function screenSegments(s: Screen): string[] {
  switch (s.name) {
    case "event":
      return ["event", enc(s.id)];
    case "topic":
      return ["topic", enc(s.id), s.part, String(s.step + 1)];
    case "attempt":
      return ["attempt", enc(s.id)];
    case "legal":
      return ["legal", s.doc];
    case "admin":
      return [s.kind];
    case "admin-edit":
      return ["edit", s.kind, enc(s.id)];
  }
}

export function toHash(state: NavState): string {
  return "#/" + [state.tab, ...state.stack.flatMap(screenSegments)].join("/");
}

function isChildTab(v: string | undefined): v is ChildTab {
  return !!v && (TABS as readonly string[]).includes(v);
}

function isKind(v: string | undefined): v is RecordKind {
  return !!v && (RECORD_KINDS as readonly string[]).includes(v);
}

function dec(s: string | undefined): string | null {
  if (!s) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Old section names from earlier links: «Теория» and «Тренировки» are now «Учёба». */
const LEGACY_TABS: Record<string, { tab: ChildTab; part?: TopicPart }> = {
  knowledge: { tab: "learn", part: "theory" },
  training: { tab: "learn", part: "practice" },
};

function parseStep(parts: string[]): number {
  if (!/^\d+$/.test(parts[0] ?? "")) return 0;
  return Math.max(0, Number.parseInt(parts.shift() as string, 10) - 1);
}

/** Parses `#/tab/screen/...`; returns null for anything else (e.g. MAX launch params). */
export function fromHash(hash: string): NavState | null {
  if (!hash.startsWith("#/")) return null;
  const parts = hash.slice(2).split("?")[0].split("/").filter(Boolean);
  const first = parts.shift();

  if (first === "admin") {
    const stack: Screen[] = [];
    const kind = isKind(parts[0]) ? (parts.shift() as RecordKind) : "olympiads";
    stack.push({ name: "admin", kind });
    if (parts[0] === "edit") {
      parts.shift();
      const editKind = parts.shift();
      const id = dec(parts.shift());
      if (isKind(editKind) && id) stack.push({ name: "admin-edit", kind: editKind, id });
    }
    return { tab: "admin", stack };
  }

  const legacy = first ? LEGACY_TABS[first] : undefined;
  const tab: ChildTab | null = legacy ? legacy.tab : isChildTab(first) ? first : null;
  if (!tab) return null;
  const stack: Screen[] = [];
  while (parts.length) {
    const name = parts.shift();
    if (name === "event") {
      const id = dec(parts.shift());
      if (!id) break;
      stack.push({ name: "event", id });
    } else if (name === "topic") {
      const id = dec(parts.shift());
      if (!id) break;
      let part: TopicPart = legacy?.part ?? "theory";
      if (parts[0] === "theory" || parts[0] === "practice") part = parts.shift() as TopicPart;
      stack.push({ name: "topic", id, part, step: parseStep(parts) });
    } else if (name === "attempt") {
      const id = dec(parts.shift());
      if (!id) break;
      stack.push({ name: "attempt", id });
    } else if (name === "legal") {
      const doc = parts.shift();
      if (!doc || !(LEGAL as readonly string[]).includes(doc)) break;
      stack.push({ name: "legal", doc: doc as LegalDoc });
    } else break;
  }
  return { tab, stack };
}

export type DeepLink =
  | { type: "event"; id: string }
  | { type: "topic"; id: string }
  | { type: "mock"; id: string }
  | { type: "tab"; tab: ChildTab };

const START_PARAM_RE = /^(event|topic|mock|tab)_([A-Za-z0-9_-]{1,500})$/;

/**
 * Parses a MAX `start_param`: `event_<id>`, `topic_<id>`, `mock_<id>`, `tab_<name>`.
 * `tab_knowledge` and `tab_training` (older bot buttons) open «Учёба».
 */
export function parseStartParam(raw: string | null | undefined): DeepLink | null {
  if (!raw) return null;
  const m = START_PARAM_RE.exec(raw.trim());
  if (!m) return null;
  const [, type, value] = m;
  if (type === "tab") {
    if (LEGACY_TABS[value]) return { type: "tab", tab: LEGACY_TABS[value].tab };
    return isChildTab(value) ? { type: "tab", tab: value } : null;
  }
  return { type: type as "event" | "topic" | "mock", id: value };
}

export function makeStartParam(link: DeepLink): StartParam {
  return link.type === "tab" ? `tab_${link.tab}` : `${link.type}_${link.id}`;
}

export const TAB_LABEL: Record<ChildTab, string> = {
  home: "Главная",
  calendar: "Олимпиады",
  learn: "Учёба",
  mocks: "Пробники",
  profile: "Я",
};
