"use client";
/**
 * Region picker (ARIA 1.2 combobox). Opening always shows the full list with the
 * current region highlighted; typing filters («мос», «питер», «спб»); × resets.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, MapPin, X } from "lucide-react";
import { regions as ALL_REGIONS } from "@/lib/regions";
import { searchRegions } from "@/lib/ui/regions";

export interface RegionComboboxProps {
  value: string;
  onChange(value: string): void;
  label: string;
  /** Visible label element id, when the label is rendered outside. */
  labelledBy?: string;
  placeholder?: string;
  /** Text of the «no region» option; omit to hide it. */
  emptyOptionLabel?: string;
  regions?: readonly string[];
  id?: string;
  invalid?: boolean;
  autoFocus?: boolean;
}

export function RegionCombobox({
  value,
  onChange,
  label,
  labelledBy,
  placeholder = "Начни вводить регион",
  emptyOptionLabel,
  regions = ALL_REGIONS,
  id,
  invalid,
  autoFocus,
}: RegionComboboxProps) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const suppressOpen = useRef(false);

  const options = useMemo(() => {
    const found = searchRegions(query, regions).map((r) => ({ value: r, label: r }));
    return emptyOptionLabel && !query.trim()
      ? [{ value: "", label: emptyOptionLabel }, ...found]
      : found;
  }, [query, regions, emptyOptionLabel]);

  const openList = () => {
    setQuery("");
    const all = emptyOptionLabel ? ["", ...regions] : [...regions];
    setActive(Math.max(0, all.indexOf(value)));
    setOpen(true);
    if (window.matchMedia?.("(max-width: 720px)").matches)
      inputRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (v: string) => {
    onChange(v);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  // The list must be fully visible: between the field and the keyboard (or the bottom tab bar),
  // below the sticky top bar, inside a bottom sheet – and above the field when there is more
  // room there (a field at the bottom of a sheet, with the keyboard open).
  const [place, setPlace] = useState<{ maxHeight: number; above: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    const update = () => {
      const input = inputRef.current;
      if (!input) return;
      const sheet = input.closest<HTMLElement>(".ol-dialog");
      let top = vv ? vv.offsetTop : 0;
      let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      if (sheet) {
        const r = sheet.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      } else {
        const header = document.querySelector<HTMLElement>(".ol-topbar");
        if (header && getComputedStyle(header).position === "sticky")
          top = Math.max(top, header.getBoundingClientRect().bottom);
        const bar = document.querySelector<HTMLElement>(".ol-tabbar");
        if (bar && getComputedStyle(bar).position === "fixed") {
          const r = bar.getBoundingClientRect();
          if (r.height > 0 && r.top < bottom) bottom = r.top;
        }
      }
      const field = input.getBoundingClientRect();
      const below = Math.floor(bottom - field.bottom - 10);
      const above = Math.floor(field.top - top - 10);
      const flip = below < 200 && above > below;
      setPlace({ maxHeight: Math.max(120, Math.min(340, flip ? above : below)), above: flip });
    };
    // The keyboard shrinks the viewport: keep the field itself in sight, then re-measure.
    const onResize = () => {
      inputRef.current?.scrollIntoView?.({ block: "nearest" });
      update();
    };
    update();
    vv?.addEventListener("resize", onResize);
    vv?.addEventListener("scroll", update);
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", onResize);
    return () => {
      vv?.removeEventListener("resize", onResize);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const activeId = open && options[active] ? `${listId}-opt-${active}` : undefined;

  return (
    <div className={"ol-combobox" + (open ? " is-open" : "") + (invalid ? " is-invalid" : "")}>
      <MapPin size={18} aria-hidden className="ol-combobox-icon" />
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={open ? value || placeholder : placeholder}
        value={open ? query : value}
        onFocus={() => {
          if (suppressOpen.current) suppressOpen.current = false;
          else if (!open) openList();
        }}
        onClick={() => {
          if (!open) openList();
        }}
        onBlur={() => close()}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) openList();
            else setActive((i) => Math.min(options.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            if (open && options[active]) {
              e.preventDefault();
              choose(options[active].value);
            }
          } else if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              close();
            }
          }
        }}
      />
      {value && !open ? (
        <button
          type="button"
          className="ol-combobox-clear"
          aria-label="Сбросить регион"
          onClick={() => {
            onChange("");
            suppressOpen.current = true;
            inputRef.current?.focus({ preventScroll: true });
          }}
        >
          <X size={18} aria-hidden />
        </button>
      ) : (
        <ChevronDown size={18} aria-hidden className="ol-combobox-chevron" />
      )}
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        className={"ol-combobox-list" + (open && place?.above ? " is-above" : "")}
        hidden={!open}
        style={open && place ? { maxHeight: place.maxHeight } : undefined}
      >
        {open &&
          options.map((o, i) => (
            <li
              key={o.value || "__all"}
              id={`${listId}-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              className={
                (i === active ? "is-active " : "") + (o.value === value ? "is-selected" : "")
              }
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(o.value)}
            >
              <span>{o.label}</span>
              {o.value === value && <Check size={18} aria-hidden />}
            </li>
          ))}
        {open && !options.length && (
          <li
            className="ol-combobox-empty"
            role="option"
            aria-disabled="true"
            aria-selected="false"
          >
            Такой регион не нашли. Попробуй начать с названия: «Москва», «Татарстан»
          </li>
        )}
      </ul>
    </div>
  );
}
