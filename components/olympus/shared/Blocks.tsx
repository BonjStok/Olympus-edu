"use client";
/** Lesson content blocks: text, examples, formulas (KaTeX, loaded lazily), media, tables. */
import { useEffect, useState } from "react";
import type { LessonBlock } from "@/lib/domain/types";
import { ExternalLink } from "./layout";

export function Formula({ value }: { value: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([katex]) => {
        if (!active) return;
        setHtml(
          katex.default.renderToString(value || "", {
            throwOnError: false,
            displayMode: true,
            trust: false,
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [value]);
  return html ? (
    <div className="ol-formula" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <div className="ol-formula ol-formula--raw">{value}</div>
  );
}

function Table({ value }: { value: string }) {
  const rows = value
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => r.split("|").map((c) => c.trim()));
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return (
    <div className="ol-table-wrap" tabIndex={0} role="region" aria-label="Таблица">
      <table>
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Block({ block }: { block: LessonBlock }) {
  switch (block.type) {
    case "image":
      return (
        <figure className="ol-figure">
          <img
            loading="lazy"
            decoding="async"
            src={block.value}
            alt={block.caption || "Иллюстрация к уроку"}
          />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case "video":
      return (
        <figure className="ol-figure">
          <video controls preload="metadata" src={block.value} />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case "link":
      return (
        <p>
          <ExternalLink href={block.value} className="ol-link ol-link--block">
            {block.caption || "Открыть материал"}
          </ExternalLink>
        </p>
      );
    case "code":
      return (
        <pre className="ol-code" tabIndex={0}>
          {block.value}
        </pre>
      );
    case "formula":
      return <Formula value={block.value} />;
    case "table":
      return <Table value={block.value} />;
    case "list":
      return (
        <ul className="ol-list">
          {block.value
            .split("\n")
            .filter((s) => s.trim())
            .map((s, i) => (
              <li key={i}>{s}</li>
            ))}
        </ul>
      );
    case "example":
      return (
        <div className="ol-example">
          <span className="ol-example-label">Пример</span>
          <p>{block.value}</p>
        </div>
      );
    default:
      return <p className="ol-text">{block.value}</p>;
  }
}

export function Blocks({ blocks }: { blocks: readonly LessonBlock[] | undefined }) {
  return (
    <div className="ol-lesson-content">
      {(blocks ?? []).map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
