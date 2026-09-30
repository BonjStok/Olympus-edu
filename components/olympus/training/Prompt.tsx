"use client";
/** Task statement: plain text with fenced ```code``` blocks rendered as code. */
import { splitPrompt } from "@/lib/ui/learning";

export function Prompt({ text }: { text: string }) {
  const parts = splitPrompt(text ?? "");
  return (
    <div className="ol-prompt">
      {parts.map((p, i) =>
        p.type === "code" ? (
          <pre key={i} className="ol-code" tabIndex={0} aria-label="Код программы">
            <code>{p.value}</code>
          </pre>
        ) : (
          p.value.split(/\n{2,}/).map((para, j) => (
            <p key={`${i}-${j}`} className="ol-prompt-text">
              {para}
            </p>
          ))
        ),
      )}
    </div>
  );
}
