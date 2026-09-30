"use client";
/** Small form controls: labelled field, native select, segmented choice, chips. */
import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  optional?: boolean;
}) {
  return (
    <div className={"ol-field" + (error ? " ol-field--error" : "")}>
      <label className="ol-field-label" htmlFor={htmlFor}>
        {label}
        {optional && <span className="ol-field-optional"> · необязательно</span>}
      </label>
      {children}
      {error ? (
        <p className="ol-field-error" role="alert" id={htmlFor ? `${htmlFor}-error` : undefined}>
          {error}
        </p>
      ) : hint ? (
        <p className="ol-field-hint" id={htmlFor ? `${htmlFor}-hint` : undefined}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface Option<V extends string> {
  value: V;
  label: string;
}

/** Native select: best picker on phones, accessible everywhere. */
export function Select<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
  ...rest
}: {
  value: V;
  onChange(value: V): void;
  options: readonly Option<V>[];
  label: string;
  className?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <span className={"ol-select " + (className ?? "")}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={18} aria-hidden className="ol-select-icon" />
    </span>
  );
}

/** Single choice shown as a row of buttons (radiogroup semantics). */
export function Segmented<V extends string | number>({
  value,
  onChange,
  options,
  label,
  className,
  size = "normal",
}: {
  value: V | null;
  onChange(value: V): void;
  options: readonly { value: V; label: ReactNode; aria?: string }[];
  label: string;
  className?: string;
  size?: "normal" | "small";
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`ol-segmented ol-segmented--${size} ${className ?? ""}`}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const i = options.findIndex((o) => o.value === value);
        const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        const next = options[(i + d + options.length) % options.length];
        onChange(next.value);
        const el = document.getElementById(`${id}-${String(next.value)}`);
        el?.focus();
      }}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={String(o.value)}
            id={`${id}-${String(o.value)}`}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.aria}
            tabIndex={checked || (value === null && o === options[0]) ? 0 : -1}
            className={checked ? "is-checked" : ""}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Multiple choice chips (checkbox semantics). */
export function ChipToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={"ol-chip" + (checked ? " is-checked" : "")}
      onClick={() => onChange(!checked)}
    >
      {children}
    </button>
  );
}
