"use client";
/** Form building blocks for the teacher's editor: labelled field, dates, upload. */
import { Spinner } from "@maxhub/max-ui";
import { Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/client/api";
import { isIsoDay } from "@/lib/ui/dates";
import { useData } from "../state/data";

export function fieldId(key: string): string {
  return `f-${key.replace(/[^\w-]/g, "-")}`;
}

export function AField({
  name,
  label,
  error,
  hint,
  optional,
  children,
}: {
  name: string;
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
}) {
  const id = fieldId(name);
  return (
    <div className={"ol-field" + (error ? " ol-field--error" : "")} data-field={name}>
      <label className="ol-field-label" htmlFor={id}>
        {label}
        {optional && <span className="ol-field-optional"> · можно не заполнять</span>}
      </label>
      {children}
      {error ? (
        <p className="ol-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="ol-field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Props for a native control inside AField. */
export function control(name: string, error?: string) {
  const id = fieldId(name);
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : `${id}-hint`,
  } as const;
}

/** A date that may be «not announced yet» (`expected`) or, optionally, absent. */
export function DateField({
  name,
  label,
  value,
  onChange,
  error,
  expectedLabel,
  optional,
  hint,
}: {
  name: string;
  label: string;
  value: string | undefined;
  onChange(v: string | undefined): void;
  error?: string;
  /** Show the «not announced» checkbox with this text. */
  expectedLabel?: string;
  optional?: boolean;
  hint?: ReactNode;
}) {
  const expected = !!expectedLabel && !!value && !isIsoDay(value);
  return (
    <AField name={name} label={label} error={error} optional={optional} hint={hint}>
      <div className="ol-date-field">
        <input
          {...control(name, error)}
          className="ol-input"
          type="date"
          value={isIsoDay(value) ? value : ""}
          disabled={expected}
          onChange={(e) => onChange(e.target.value || (optional ? undefined : ""))}
        />
        {expectedLabel && (
          <label className="ol-check">
            <input
              type="checkbox"
              checked={expected}
              onChange={(e) => onChange(e.target.checked ? "expected" : "")}
            />
            {expectedLabel}
          </label>
        )}
      </div>
    </AField>
  );
}

/** Uploads an image/video/PDF to the server media store and returns its URL. */
export function UploadButton({
  accept,
  onUploaded,
  label = "Загрузить файл",
}: {
  accept: string;
  onUploaded(url: string): void;
  label?: string;
}) {
  const data = useData();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) return setError("Файл больше 8 МБ – уменьшите его");
    setPending(true);
    setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const res = await data.api.call(
        "upload",
        { base64: btoa(binary), type: file.type },
        { timeoutMs: 60_000 },
      );
      onUploaded(res.url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="ol-upload-inline">
      <label
        className={"ol-upload-btn" + (pending ? " is-pending" : "")}
        aria-busy={pending || undefined}
      >
        {pending ? <Spinner size={16} appearance="themed" /> : <Upload size={16} aria-hidden />}
        {pending ? "Загружаем…" : label}
        <input
          type="file"
          accept={accept}
          className="ol-visually-hidden"
          disabled={pending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </label>
      {error && (
        <p className="ol-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
