"use client";
/**
 * Import: olympiads from a spreadsheet (CSV with Russian columns) or any kind from JSON.
 * The file is checked first; the teacher sees errors per row and confirms publication.
 */
import { Button } from "@maxhub/max-ui";
import { Download, FileSpreadsheet, FileJson, Upload } from "lucide-react";
import { useState } from "react";
import type { ContentRecord, RecordKind } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { KIND_LABEL } from "@/lib/ui/format";
import {
  formatCsvError,
  olympiadCsvTemplate,
  olympiadsFromCsv,
  OLYMPIAD_COLUMNS,
  type CsvRowError,
} from "@/lib/ui/olympiad-csv";
import { plural, WORDS } from "@/lib/ui/plural";
import { Segmented } from "../shared/controls";
import { Dialog } from "../shared/Dialog";
import { useData } from "../state/data";
import { useToast } from "../state/toast";
import { downloadText } from "./common";
import { JSON_EXAMPLES } from "./examples";

type Mode = "csv" | "json";

interface Prepared {
  records: ContentRecord[];
  errors: string[];
  fileName: string;
}

export function ImportDialog({
  open,
  kind,
  onClose,
}: {
  open: boolean;
  kind: RecordKind;
  onClose(): void;
}) {
  const data = useData();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(kind === "olympiads" ? "csv" : "json");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const csvAllowed = kind === "olympiads";
  const activeMode: Mode = csvAllowed ? mode : "json";

  const reset = () => {
    setPrepared(null);
    setServerError(null);
  };

  const readFile = async (file: File) => {
    reset();
    const text = await file.text();
    if (activeMode === "csv") {
      const { records, errors } = olympiadsFromCsv(text);
      setPrepared({
        records,
        errors: errors.map((e: CsvRowError) => formatCsvError(e)),
        fileName: file.name,
      });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const errors: string[] = [];
      if (!items.length) errors.push("В файле нет ни одного материала");
      items.forEach((it, i) => {
        if (!it || typeof it !== "object" || Array.isArray(it))
          errors.push(`Запись ${i + 1}: это не объект JSON`);
      });
      const records = errors.length
        ? []
        : (items as Record<string, unknown>[]).map(
            (r) => ({ ...r, kind }) as unknown as ContentRecord,
          );
      setPrepared({ records, errors, fileName: file.name });
    } catch {
      setPrepared({
        records: [],
        errors: ["В файле ошибка JSON. Сравните его с примером формата ниже"],
        fileName: file.name,
      });
    }
  };

  const publish = async () => {
    if (!prepared?.records.length) return;
    setPending(true);
    setServerError(null);
    try {
      const res = await data.api.call("import", { records: prepared.records });
      await data.load();
      toast.success(
        `Опубликовано: ${plural(res.count ?? prepared.records.length, WORDS.material)}`,
      );
      reset();
      onClose();
    } catch (e) {
      setServerError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
      title={`Импорт · ${KIND_LABEL[kind]}`}
      description="Сначала проверим файл, потом попросим подтвердить публикацию"
      size="wide"
      busy={pending}
      footer={
        prepared?.records.length ? (
          <>
            <Button size="large" variant="secondary" stretched disabled={pending} onClick={reset}>
              Выбрать другой файл
            </Button>
            <Button size="large" stretched loading={pending} onClick={() => void publish()}>
              Опубликовать {plural(prepared.records.length, WORDS.material)}
            </Button>
          </>
        ) : undefined
      }
    >
      {csvAllowed && (
        <Segmented
          label="Формат файла"
          value={activeMode}
          onChange={(m) => {
            setMode(m);
            reset();
          }}
          options={[
            { value: "csv" as Mode, label: "Таблица (CSV)" },
            { value: "json" as Mode, label: "JSON" },
          ]}
        />
      )}
      {activeMode === "csv" ? (
        <div className="ol-import-guide">
          <p>
            Заполните таблицу в Excel или Google Таблицах и сохраните как CSV. Одна строка – одна
            олимпиада. Столбцы:
          </p>
          <p className="ol-columns">{OLYMPIAD_COLUMNS.join(" · ")}</p>
          <ul className="ol-list">
            <li>Даты – в виде 20.10.2026 или словом «ожидается».</li>
            <li>Предмет – «Математика» или «Информатика»; классы – «4, 5, 6».</li>
            <li>
              Регион пустой – олимпиада для всей России. Для региональной – название как в списке
              регионов.
            </li>
            <li>«Как участвовать» – «Ссылка» (регистрация на сайте) или «Через школу».</li>
          </ul>
          <Button
            variant="secondary"
            size="small"
            iconBefore={<Download size={16} aria-hidden />}
            onClick={() =>
              downloadText(olympiadCsvTemplate(), "olimpiady-shablon.csv", "text/csv;charset=utf-8")
            }
          >
            Скачать шаблон таблицы
          </Button>
        </div>
      ) : (
        <div className="ol-import-guide">
          <p>
            Файл может содержать один материал или список. Все записи попадут в раздел «
            {KIND_LABEL[kind]}». Запись с уже существующим кодом (id) обновится, остальные материалы
            и достижения детей сохранятся.
          </p>
          <Button
            variant="secondary"
            size="small"
            iconBefore={<Download size={16} aria-hidden />}
            onClick={() =>
              downloadText(JSON.stringify(JSON_EXAMPLES[kind], null, 2), `${kind}-primer.json`)
            }
          >
            Скачать пример
          </Button>
          <details>
            <summary>Показать пример</summary>
            <pre className="ol-code">{JSON.stringify(JSON_EXAMPLES[kind], null, 2)}</pre>
          </details>
        </div>
      )}

      <label className="ol-upload">
        {activeMode === "csv" ? (
          <FileSpreadsheet size={26} aria-hidden />
        ) : (
          <FileJson size={26} aria-hidden />
        )}
        <b>{prepared ? `Файл: ${prepared.fileName}` : "Выбрать файл"}</b>
        <span>{activeMode === "csv" ? "Таблица .csv" : "Файл .json"}</span>
        <input
          type="file"
          accept={activeMode === "csv" ? ".csv,text/csv" : ".json,application/json"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void readFile(file);
            e.target.value = "";
          }}
        />
        <Upload size={18} aria-hidden className="ol-upload-icon" />
      </label>

      {prepared && (
        <div className="ol-import-result" aria-live="polite">
          {prepared.records.length > 0 && (
            <p className="ol-note ol-note--ok">
              Готово к публикации: {plural(prepared.records.length, WORDS.material)}.
              {prepared.errors.length > 0 &&
                " Строки с ошибками пропустим – их можно исправить и загрузить позже."}
            </p>
          )}
          {prepared.errors.length > 0 && (
            <div className="ol-import-errors" role="alert">
              <b>Нужно исправить ({prepared.errors.length}):</b>
              <ul>
                {prepared.errors.slice(0, 30).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              {prepared.errors.length > 30 && <p>…и ещё {prepared.errors.length - 30}</p>}
            </div>
          )}
        </div>
      )}
      {serverError && (
        <p className="ol-field-error" role="alert">
          Сервер не принял файл: {serverError}
        </p>
      )}
    </Dialog>
  );
}
