/**
 * Shared domain model of Olympus: content records, user progress and the
 * RPC contract of `/api/olympus` used by the mini-app UI.
 *
 * This file is the single source of truth for both the server and the client.
 * Keep it free of runtime imports so it can be used anywhere.
 */

export type Subject = "math" | "info";
export type Grade = 4 | 5 | 6;
export type RecordKind = "olympiads" | "topics" | "lessons" | "tasks" | "mock-tests";

/** Date in `YYYY-MM-DD` or the marker `expected` (the organiser has not announced it yet). */
export type EventDate = string;

interface BaseRecord {
  id: string;
  kind: RecordKind;
  title: string;
  /** Present on drafts that were never published. Hidden from children. */
  unpublished?: boolean;
  /** Simulated/demo record – must be labelled as such in the UI and docs. */
  demo?: boolean;
}

/**
 * Olympiad calendar entry.
 *
 * Scope rules (used by the region filter):
 * - `region === ""` – the event is open to the whole country (regardless of format);
 * - `region !== ""` – the event belongs to that region only, even when it is held online
 *   (e.g. the school stage of ВсОШ on the Sirius platform has per-region dates).
 *
 * Regional editions of one olympiad share the same `series`; when no region is chosen
 * the UI collapses a series into a single card.
 */
export interface Olympiad extends BaseRecord {
  kind: "olympiads";
  subject: Subject;
  /** When the olympiad covers several subjects. `subject` stays the primary one. */
  subjects?: Subject[];
  grades: Grade[];
  format: "online" | "offline";
  /** Exact name from `lib/regions.ts`, or "" for all-Russia events. */
  region: string;
  /** Group key for regional editions of the same olympiad, e.g. `vsosh-school-2026-math`. */
  series?: string;
  /** Short human label of the stage, e.g. «Школьный этап». */
  stage?: string;
  /**
   * How a child takes part:
   * - `link` (default): `url` is the organiser's registration page;
   * - `school`: there is no individual sign-up, the school registers participants;
   *   `url` is the official page that explains how to take part.
   */
  registrationType?: "link" | "school";
  url: string;
  /** Start of the registration window, `YYYY-MM-DD`. */
  registrationStart?: string;
  /** Registration deadline. Optional when `registrationType === "school"`. */
  deadline?: EventDate;
  /** Day of the olympiad (first day for multi-day events). */
  date: EventDate;
  /** Last day for multi-day events or submission windows, `YYYY-MM-DD`. */
  dateEnd?: string;
  price?: number;
  image?: string;
  featured?: boolean;
  description?: string;
  /** Official page the dates and link were verified against. */
  source?: string;
  /** Day the record was last verified against `source`, `YYYY-MM-DD`. */
  verifiedAt?: string;
}

export interface Topic extends BaseRecord {
  kind: "topics";
  grade: Grade;
  subject: Subject;
  order: number;
  description?: string;
}

export type LessonBlockType =
  "text" | "example" | "formula" | "image" | "video" | "link" | "list" | "table" | "code";

export interface LessonBlock {
  type: LessonBlockType;
  value: string;
  caption?: string;
}

export interface Lesson extends BaseRecord {
  kind: "lessons";
  grade: Grade;
  subject: Subject;
  topicId: string;
  order: number;
  blocks: LessonBlock[];
}

export type TaskType = "number" | "proof" | "code";

export interface CodeTest {
  input: string;
  output: string;
}

/** Full task as stored on the server. Never send `answer`, `solution`, `hint`, `tests` to a child before it is allowed. */
export interface Task extends BaseRecord {
  kind: "tasks";
  grade: Grade;
  subject: Subject;
  topicId: string;
  order: number;
  type: TaskType;
  prompt: string;
  answer?: string;
  solution: string;
  hint?: string;
  points?: number;
  tests?: CodeTest[];
  /** Public example shown to the child (first test of a code task). */
  example?: CodeTest;
}

/** Task as the child sees it during practice or an unfinished mock test. */
export type PublicTask = Omit<Task, "answer" | "solution" | "hint" | "tests">;
/** Task after a mock test is finished: answers and solutions are revealed, hidden tests never are. */
export type ReviewedTask = Omit<Task, "tests">;

export interface MockTest extends BaseRecord {
  kind: "mock-tests";
  grade: Grade;
  subject: Subject;
  /** Name of the olympiad this mock prepares for (used as a filter). */
  olympiad: string;
  minutes: number;
  taskIds: string[];
  randomize?: boolean;
  taskCount?: number;
}

export type ContentRecord = Olympiad | Topic | Lesson | Task | MockTest;

/** Fields of an olympiad that only its details screen shows (loaded with the action `olympiad`). */
export type OlympiadDetailField = "description" | "source" | "verifiedAt" | "image";
/** Olympiad in the children's catalogue: everything the calendar lists need, no heavy fields. */
export type OlympiadSummary = Omit<Olympiad, OlympiadDetailField>;

/** Lightweight list entries returned to children by `GET /api/olympus`. */
export type LessonSummary = Pick<
  Lesson,
  "id" | "kind" | "title" | "grade" | "subject" | "topicId" | "order" | "unpublished"
>;
export type TaskSummary = Pick<
  Task,
  | "id"
  | "kind"
  | "title"
  | "grade"
  | "subject"
  | "topicId"
  | "order"
  | "type"
  | "points"
  | "unpublished"
>;
export type RecordSummary = OlympiadSummary | Topic | MockTest | LessonSummary | TaskSummary;
/**
 * Entry of `GET /api/v1/content` (openapi.yaml): the same catalogue, but olympiads are complete.
 * The evaluator API keeps this shape; only the mini-app catalogue is slimmed down.
 */
export type ContentSummary = Olympiad | Topic | MockTest | LessonSummary | TaskSummary;

/** Admin view: the published record plus its pending draft, if any. */
export type AdminRecord = ContentRecord & { draft: ContentRecord | null };

// ---------------------------------------------------------------------------
// Progress. Stored in table `progress` as (user_id, key) -> JSON value.
// ---------------------------------------------------------------------------

/** `lesson:<lessonId>` */
export interface LessonProgress {
  read: true;
}

/** `task:<taskId>` */
export interface TaskProgress {
  title: string;
  topicId: string;
  subject: Subject;
  /** Was ever solved correctly. */
  correct: boolean;
  /** Result of the latest attempt. */
  lastCorrect: boolean;
  attempts: number;
  /** Proof tasks are graded by the child (self-check). */
  selfChecked: boolean;
  /** The child opened the solution (`reveal`) before solving the task. */
  revealed?: boolean;
  /** Solved only after the solution was revealed: shown as solved, but earns no stars. */
  solvedAfterReveal?: boolean;
}

/** `registration:<olympiadId>` – the child confirmed they registered / will take part. */
export interface RegistrationProgress {
  registered: true;
}

/** `code:<taskId>` – autosaved code draft. */
export interface CodeDraft {
  code: string;
  language: CodeLanguage;
}

/** `theory-star:<topicId>`, `practice-star:<topicId>` (legacy: `star:<topicId>`). */
export interface StarProgress {
  title: string;
  subject: Subject;
  type: "theory" | "practice";
  date: number;
}

/** `settings` – personal preferences that should follow the child between devices. */
export interface UserSettings {
  region?: string;
  grade?: Grade;
  subject?: Subject;
}

export type MockAnswer = string | { code: string; language: CodeLanguage };

/**
 * - `correct` / `wrong`: graded (automatically or by the child's self-check);
 * - `unchecked`: a code answer the runner could not check yet (see action `mock-recheck`);
 * - `self-check`: a proof waiting for the child's self-check (action `mock-proof`).
 */
export type MockResultStatus = "correct" | "wrong" | "unchecked" | "self-check";

export interface MockResult {
  id: string;
  correct: boolean;
  /** Points earned; 0 unless `status === "correct"`. */
  points: number;
  max: number;
  note: string;
  /** Always present in server responses (older stored attempts are upgraded on read). */
  status?: MockResultStatus;
}

/** `attempt:<attemptId>` */
export interface MockAttempt<T = PublicTask | ReviewedTask> {
  id: string;
  testId: string;
  title: string;
  subject: Subject;
  started: number;
  ends: number;
  tasks: T[];
  answers: Record<string, MockAnswer>;
  finished: boolean;
  finishedAt?: number;
  results?: MockResult[];
  /** Sum of points of `correct` results. */
  score?: number;
  /** Maximum possible score of the attempt. */
  max?: number;
  /** Number of `unchecked` results that `mock-recheck` may still grade. */
  pending?: number;
}

export type ProgressMap = Record<string, unknown>;

export const CODE_LANGUAGES = ["python", "cpp", "java", "javascript", "kotlin", "pascal"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

// ---------------------------------------------------------------------------
// RPC contract of `/api/olympus` (mini-app UI <-> server).
//
// Auth: the server accepts the session either from the `olympus_session` cookie or from
// `Authorization: Bearer <sessionToken>`. The header exists because MAX Web may embed the
// mini-app in a cross-site iframe where cookies are not stored.
//
// Origin: POST requests authenticated by the cookie (or without a session) must come from the
// app's own origin (`Origin` header), otherwise 403 `BAD_ORIGIN`. Requests that carry an
// `Authorization` header are exempt. POST bodies must be `application/json` (415 otherwise).
//
// Errors: non-2xx responses have the body `{ error: string; code: ApiErrorCode }` where `error`
// is a human-readable Russian message that can be shown to a child as is. Statuses:
//   400 malformed request or invalid content record, 401 no/expired session or MAX sign-in failed,
//   403 wrong origin / admin required / wrong password, 404 not found (also for drafts and
//   deleted records when the caller is not an admin), 405 method other than GET/POST,
//   409 conflict with the current state,
//   413 body too large, 415 not JSON / unsupported file, 422 value cannot be processed
//   (answer, language, code, settings...), 429 too many attempts (`Retry-After` header),
//   500 unexpected error (generic message), 503 a dependency is down (database, runner, storage).
//
// Limits: JSON body 256 KB (12 MB for admin `draft`/`publish`/`import`/`upload`); ids match
// `^[a-zA-Z0-9_-]{1,100}$`; see `INPUT_LIMITS` for answers and code.
//
// Admin rights of a session expire after 60 minutes without admin activity (sliding window);
// after that the session behaves as a regular one (`profile.admin === false`) and admin actions
// answer 403 `ADMIN_EXPIRED` until the next `admin-login` (`ADMIN_REQUIRED` after `admin-logout` or
// for a session that never was an admin).
//
// Codes are named like the client's dictionary (lib/client/errors.ts). `/api/v1` uses the same
// codes except for 500, which it reports as `INTERNAL_ERROR` (openapi.yaml).
// ---------------------------------------------------------------------------

/** Size limits of user input enforced by the server. */
export const INPUT_LIMITS = {
  /** Program source (check, run, code-draft, mock answers). */
  code: 50_000,
  /** Text answer of a mock task. */
  textAnswer: 2_000,
  /** stdin of a practice run. */
  runInput: 100_000,
} as const;

export type ApiErrorCode =
  // 400
  | "INVALID_REQUEST"
  | "INVALID_JSON"
  | "INVALID_ID"
  | "UNKNOWN_ACTION"
  | "VALIDATION_ERROR"
  | "NOT_CODE_TASK"
  // 400 (malformed launch data) or 401 (bad signature, older than an hour)
  | "MAX_AUTH_FAILED"
  // 401
  | "SESSION_EXPIRED"
  /** `/api/v1` only: missing or wrong test_user token. */
  | "UNAUTHORIZED"
  | "INVALID_CREDENTIALS"
  // 403
  | "BAD_ORIGIN"
  | "ADMIN_REQUIRED"
  | "ADMIN_EXPIRED"
  | "WRONG_PASSWORD"
  // 404
  | "NOT_FOUND"
  | "TOPIC_NOT_FOUND"
  | "LESSON_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "OLYMPIAD_NOT_FOUND"
  | "MOCK_NOT_FOUND"
  | "ATTEMPT_NOT_FOUND"
  | "RECORD_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  // 405
  | "METHOD_NOT_ALLOWED"
  // 409
  | "MOCK_IN_PROGRESS"
  | "MOCK_NOT_FINISHED"
  | "ATTEMPT_FINISHED"
  | "ATTEMPT_TIME_EXPIRED"
  | "TOPIC_HAS_NO_LESSONS"
  | "LESSONS_NOT_READ"
  | "DUPLICATE_OLYMPIAD"
  | "KIND_CONFLICT"
  // 413
  | "PAYLOAD_TOO_LARGE"
  | "FILE_TOO_LARGE"
  // 415
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNSUPPORTED_FILE_TYPE"
  // 422
  | "INVALID_ANSWER"
  | "INVALID_SELF_CHECK"
  | "INVALID_LANGUAGE"
  | "INVALID_CODE"
  | "INVALID_INPUT"
  | "INVALID_ANSWERS"
  | "INVALID_REGISTERED"
  | "INVALID_SETTINGS"
  | "INVALID_FILE"
  | "INVALID_CREDENTIALS_FORMAT"
  // 429
  | "RATE_LIMITED"
  | "RUNNER_BUSY"
  // 500
  | "SERVER_ERROR"
  // 503
  | "DATABASE_UNAVAILABLE"
  | "DATABASE_NOT_CONFIGURED"
  | "RUNNER_UNAVAILABLE"
  | "MAX_NOT_CONFIGURED"
  | "ADMIN_NOT_CONFIGURED"
  | "STORAGE_UNAVAILABLE"
  | "TEST_ACCOUNT_NOT_CONFIGURED";

export interface Profile {
  name: string | null;
  photo: null;
  /** Signed in through MAX (progress syncs between devices). */
  max: boolean;
  admin: boolean;
}

export interface Features {
  /** Code runner is configured (informatics tasks can be checked). */
  runner: boolean;
  /** MAX sign-in is configured on the server (BOT_TOKEN present). */
  max: boolean;
  /** The chat-bot can send olympiad reminders to MAX users (`BOT_TOKEN` set and `BOT_REMINDERS=on`). */
  reminders: boolean;
  /** Public name of the MAX bot (`MAX_BOT_NAME`) for «Открыть в MAX» / share links, or null. */
  botName: string | null;
}

export interface BootstrapResponse {
  records: RecordSummary[] | AdminRecord[];
  progress: ProgressMap;
  profile: Profile;
  features: Features;
  sessionToken: string;
  /** Server clock (ms since epoch) when the response was built; mock timers use it. */
  serverTime: number;
  /** @deprecated use `features.runner` */
  runner: boolean;
  /** @deprecated use `features.max` */
  maxConnected: boolean;
}

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
}

export interface CheckResult {
  correct: boolean;
  output: string;
  /** The practice star of the topic was awarded by this check. */
  practiceStar: boolean;
  /** Present when the task counts as solved only after its solution was revealed. */
  solvedAfterReveal?: boolean;
}

export interface RunResult {
  correct: boolean;
  output: string;
  passed?: number;
  total?: number;
}

export interface Revision {
  id: string;
  record_id: string;
  data: ContentRecord;
  created: number;
}

/** Partial settings update: omitted fields are kept, `null` clears a field. */
export type UserSettingsUpdate = { [K in keyof UserSettings]?: UserSettings[K] | null };

/**
 * Request/response pairs keyed by `action`.
 *
 * - `session` with `initData` verifies MAX launch data and returns a new token (and the signed
 *   `start_param` as `startParam`, when present); without it, returns the current token or starts
 *   a guest session.
 * - `admin-login` rotates the session token: use the returned `sessionToken` from now on.
 * - `mock-save` / `finish-mock` merge `answers` into the stored ones: present keys overwrite,
 *   `""` or `null` removes an answer; keys must be task ids of the attempt.
 * - `reveal` / `hint` answer 409 `MOCK_IN_PROGRESS` while the task is part of the caller's running
 *   mock attempt.
 */
export interface OlympusRpc {
  session: {
    req: { initData?: string };
    res: { ok: true; sessionToken: string; startParam?: string };
  };
  settings: { req: UserSettingsUpdate; res: { ok: true; settings: UserSettings } };
  "admin-login": { req: { password: string }; res: { ok: true; sessionToken: string } };
  "admin-logout": { req: Record<string, never>; res: { ok: true } };
  "view-lesson": { req: { id: string }; res: { ok: true } };
  star: { req: { id: string }; res: { ok: true } };
  register: { req: { id: string; yes: boolean }; res: { ok: true; registered: boolean } };
  /**
   * Complete olympiad for its details screen (`description`, `source`, `verifiedAt`, `image` are
   * not in the bootstrap catalogue). Children get published olympiads only: drafts, deleted and
   * unknown ids answer 404 `OLYMPIAD_NOT_FOUND`.
   */
  olympiad: { req: { id: string }; res: { olympiad: Olympiad } };
  "code-draft": { req: { id: string; code: string; language: CodeLanguage }; res: { ok: true } };
  "topic-content": { req: { id: string }; res: { lessons: Lesson[]; tasks: PublicTask[] } };
  check: {
    req: { id: string; answer?: string; correct?: boolean; code?: string; language?: CodeLanguage };
    res: CheckResult;
  };
  run: { req: { id: string; code: string; language: CodeLanguage; input: string }; res: RunResult };
  hint: { req: { id: string }; res: { hint: string } };
  reveal: { req: { id: string }; res: { answer?: string; solution: string } };
  "start-mock": { req: { id: string }; res: { attempt: MockAttempt<PublicTask> } };
  /** Current state of the caller's attempt (to resume it without a full reload). */
  "mock-get": { req: { id: string }; res: { attempt: MockAttempt } };
  /**
   * Saves answers of a running attempt. Answers are merged into the stored ones and `""` or
   * `null` removes one answer.
   */
  "mock-save": {
    req: { id: string; answers: Record<string, MockAnswer | null> };
    /** `{ attempt }` when the attempt is already finished or its time is over (then it is finished). */
    res: { ok: true } | { attempt: MockAttempt<ReviewedTask> };
  };
  "finish-mock": {
    req: { id: string; answers?: Record<string, MockAnswer | null> };
    res: { attempt: MockAttempt<ReviewedTask> };
  };
  /** Re-grades `unchecked` code answers of a finished attempt (e.g. after the runner is back). */
  "mock-recheck": { req: { id: string }; res: { attempt: MockAttempt<ReviewedTask> } };
  "mock-proof": {
    req: { id: string; taskId: string; correct: boolean };
    res: { attempt: MockAttempt<ReviewedTask> };
  };
  history: { req: { id: string }; res: { history: Revision[] } };
  restore: { req: { revisionId: string }; res: { ok: true } };
  delete: { req: { id: string }; res: { ok: true } };
  deleted: { req: Record<string, never>; res: { deleted: ContentRecord[] } };
  draft: { req: { record: ContentRecord }; res: { ok: true; count: number } };
  publish: { req: { record: ContentRecord }; res: { ok: true; count: number } };
  import: { req: { records: ContentRecord[] }; res: { ok: true; count: number } };
  upload: {
    req: { base64: string; type: string };
    res: { url: string; id: string; type: string; size: number };
  };
}

export type OlympusAction = keyof OlympusRpc;

/**
 * Deep-link payloads passed to the mini-app as MAX `start_param`
 * (e.g. from bot buttons). Format: `<kind>_<id>`.
 */
export type StartParam =
  | `event_${string}`
  | `topic_${string}`
  | `mock_${string}`
  | `tab_${"home" | "calendar" | "learn" | "knowledge" | "training" | "mocks" | "profile"}`;
