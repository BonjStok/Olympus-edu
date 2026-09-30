"use client";
/**
 * Code editor for informatics tasks: autosaved draft (flushed on leaving), run with
 * own input, check against hidden tests. When the checker is down it says so kindly,
 * keeps saving the code and leaves «Посмотреть решение» available.
 */
import { Button } from "@maxhub/max-ui";
import { Code2, Play } from "lucide-react";
import { useId, useState } from "react";
import {
  CODE_LANGUAGES,
  type CodeDraft,
  type CodeLanguage,
  type PublicTask,
} from "@/lib/domain/types";
import { errorMessage, isApiError } from "@/lib/client/api";
import { RUNNER_DOWN } from "@/lib/client/errors";
import { LANGUAGE_LABEL } from "@/lib/ui/format";
import { useDebouncedSave, type SaveStatus } from "../hooks/useDebouncedSave";
import { Select } from "../shared/controls";
import { useData } from "../state/data";

/** The languages school olympiads use most come first. */
const LANGUAGE_ORDER: readonly CodeLanguage[] = [
  "python",
  "pascal",
  "cpp",
  ...CODE_LANGUAGES.filter((l) => !["python", "pascal", "cpp"].includes(l)),
];

const SAVE_TEXT: Record<SaveStatus, string> = {
  idle: "Код сохраняется автоматически",
  pending: "Сохраним через секунду…",
  saving: "Сохраняем…",
  saved: "Код сохранён",
  error: "Не сохранилось – попробуем ещё раз при следующем изменении",
};

const PLACEHOLDER: Partial<Record<CodeLanguage, string>> = {
  python: "# Напиши решение здесь\nn = int(input())\nprint(n)",
  pascal: "begin\n  { Напиши решение здесь }\nend.",
  cpp: "#include <iostream>\nint main() {\n  // Напиши решение здесь\n}",
};

export interface CodeValue {
  code: string;
  language: CodeLanguage;
}

/** Plain editor (used by practice and by mock tests). */
export function CodeEditor({
  value,
  onChange,
  status,
  label = "Код программы",
}: {
  value: CodeValue;
  onChange(v: CodeValue): void;
  status?: SaveStatus;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="ol-code-editor">
      <div className="ol-code-top">
        <label htmlFor={`${id}-code`} className="ol-code-title">
          <Code2 size={18} aria-hidden /> {label}
        </label>
        <Select
          label="Язык программирования"
          value={value.language}
          options={LANGUAGE_ORDER.map((l) => ({ value: l, label: LANGUAGE_LABEL[l] }))}
          onChange={(language) => onChange({ ...value, language })}
        />
      </div>
      <textarea
        id={`${id}-code`}
        className="ol-code-input"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        placeholder={PLACEHOLDER[value.language] ?? "// Напиши решение здесь"}
        value={value.code}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = t;
            const next = value.code.slice(0, a) + "    " + value.code.slice(b);
            onChange({ ...value, code: next });
            requestAnimationFrame(() => t.setSelectionRange(a + 4, a + 4));
          }
        }}
        onChange={(e) => onChange({ ...value, code: e.target.value })}
      />
      {status && (
        <p className={`ol-save-status ol-save-status--${status}`} aria-live="polite">
          {SAVE_TEXT[status]}
        </p>
      )}
    </div>
  );
}

export function CodeWorkspace({
  task,
  runnerReady,
  onChecked,
}: {
  task: PublicTask;
  runnerReady: boolean;
  onChecked(result: { correct: boolean; practiceStar: boolean; output: string }): void;
}) {
  const data = useData();
  const saved = data.state.progress[`code:${task.id}`] as CodeDraft | undefined;
  const [value, setValue] = useState<CodeValue>({
    code: saved?.code ?? "",
    language: saved?.language ?? "python",
  });
  const [input, setInput] = useState(task.example?.input ?? "");
  const [output, setOutput] = useState<{
    text: string;
    /** `info` – program output, `notice` – a message from the app. */
    tone: "ok" | "error" | "info" | "notice";
  } | null>(null);
  const [busy, setBusy] = useState<"run" | "check" | null>(null);
  /** The server said the checker is down right now (even though it is configured). */
  const [runnerDown, setRunnerDown] = useState(false);
  const draft = useDebouncedSave<CodeValue>((v, opts) =>
    data.saveCodeDraft(task.id, v.code, v.language, { keepalive: opts.keepalive }),
  );
  const inputId = useId();

  /** A checker outage is not the child's mistake: a calm note instead of a red error. */
  const showFailure = (e: unknown) => {
    const code = isApiError(e) ? e.code : "";
    if (code === "RUNNER_UNAVAILABLE") {
      // The note above explains the outage; the result box just says what happened.
      setRunnerDown(true);
      setOutput({ text: "Проверить пока не получилось – попробуй чуть позже", tone: "notice" });
    } else setOutput({ text: errorMessage(e), tone: code === "RUNNER_BUSY" ? "notice" : "error" });
  };

  const change = (v: CodeValue) => {
    setValue(v);
    draft.schedule(v);
  };

  const run = async () => {
    if (!value.code.trim()) return setOutput({ text: "Сначала напиши программу", tone: "notice" });
    setBusy("run");
    try {
      await draft.flush();
      const r = await data.api.call(
        "run",
        { id: task.id, code: value.code, language: value.language, input },
        { timeoutMs: 70_000 },
      );
      setRunnerDown(false);
      setOutput({ text: r.output || "Программа ничего не вывела", tone: "info" });
    } catch (e) {
      showFailure(e);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!value.code.trim()) return setOutput({ text: "Сначала напиши программу", tone: "notice" });
    setBusy("check");
    try {
      await draft.flush();
      const r = await data.checkTask(task, { code: value.code, language: value.language });
      setOutput({
        text: r.output || (r.correct ? "Все тесты пройдены" : "Есть тесты, которые не прошли"),
        tone: r.correct ? "ok" : "error",
      });
      setRunnerDown(false);
      onChecked(r);
    } catch (e) {
      showFailure(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ol-code-workspace">
      {(!runnerReady || runnerDown) && (
        <p className="ol-note ol-note--warn" role="note">
          {RUNNER_DOWN}. Подсказка и решение – ниже.
        </p>
      )}
      <CodeEditor value={value} onChange={change} status={draft.status} />
      <div className="ol-field">
        <label className="ol-field-label" htmlFor={inputId}>
          Входные данные (можно изменить)
        </label>
        <textarea
          id={inputId}
          className="ol-code-stdin"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      <div className="ol-actions">
        <Button
          variant="secondary"
          size="large"
          stretched
          disabled={!runnerReady || !!busy}
          loading={busy === "run"}
          iconBefore={<Play size={18} aria-hidden />}
          onClick={() => void run()}
        >
          Запустить
        </Button>
        <Button
          size="large"
          stretched
          disabled={!runnerReady || !!busy}
          loading={busy === "check"}
          onClick={() => void check()}
        >
          Проверить
        </Button>
      </div>
      <div className={`ol-output${output ? ` ol-output--${output.tone}` : ""}`} aria-live="polite">
        <span className="ol-field-label">Результат</span>
        <pre>{output?.text ?? "Здесь появится вывод программы"}</pre>
      </div>
    </div>
  );
}
