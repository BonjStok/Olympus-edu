"use client";
/** Page header with an optional back link, section heading, external link button. */
import { Counter } from "@maxhub/max-ui";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { openExternal } from "@/lib/client/max-bridge";
import { useNav } from "../state/navigation";

export function BackLink({ label, onClick }: { label: string; onClick?: () => void }) {
  const nav = useNav();
  return (
    <button type="button" className="ol-back" onClick={onClick ?? nav.back}>
      <ChevronLeft size={20} aria-hidden />
      {label}
    </button>
  );
}

let screensShown = 0;

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  back,
  aside,
  tone,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  /** Label of the in-app back link, e.g. «Все темы». */
  back?: string;
  aside?: ReactNode;
  tone?: "on-accent";
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Move focus to the new screen's heading for screen readers (not on the first screen).
  useEffect(() => {
    if (screensShown++ > 0) ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className={"ol-page-header" + (tone ? ` ol-page-header--${tone}` : "")}>
      {back && <BackLink label={back} />}
      <div className="ol-page-header-row">
        <div className="ol-page-header-text">
          {eyebrow && <div className="ol-eyebrow">{eyebrow}</div>}
          <h1 ref={ref} tabIndex={-1}>
            {title}
          </h1>
          {subtitle && <p className="ol-page-subtitle">{subtitle}</p>}
        </div>
        {aside && <div className="ol-page-header-aside">{aside}</div>}
      </div>
    </header>
  );
}

export function SectionTitle({
  children,
  count,
  after,
  id,
}: {
  children: ReactNode;
  count?: ReactNode;
  after?: ReactNode;
  id?: string;
}) {
  return (
    <div className="ol-section-title">
      <h2 id={id}>
        {children}
        {typeof count === "number" ? (
          <Counter value={count} variant="primary" rounded className="ol-counter" />
        ) : (
          count !== undefined && <span className="ol-count">{count}</span>
        )}
      </h2>
      {after}
    </div>
  );
}

/** A link to an external site: opens via MAX `openLink` inside MAX. */
export function ExternalLink({
  href,
  children,
  className,
  onOpened,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  onOpened?: () => void;
}) {
  return (
    <a
      href={href}
      className={className ?? "ol-link"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
        onOpened?.();
      }}
    >
      {children}
      <ArrowUpRight size={16} aria-hidden className="ol-link-icon" />
    </a>
  );
}
