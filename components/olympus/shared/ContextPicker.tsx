"use client";
/**
 * The child's context – class, subject and region – as one reusable form, the header
 * chip «5 класс · Математика ▾» and the dialog it opens.
 */
import { Button } from "@maxhub/max-ui";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { Grade, Subject } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { useLearner, contextLabel } from "../state/learner";
import { useToast } from "../state/toast";
import { Segmented } from "./controls";
import { Dialog } from "./Dialog";
import { RegionCombobox } from "./RegionCombobox";

type SubjectChoice = Subject | "both";

export const GRADE_OPTIONS = [4, 5, 6].map((g) => ({
  value: g as Grade,
  label: String(g),
  aria: `${g} класс`,
}));

export const SUBJECT_OPTIONS: { value: SubjectChoice; label: string }[] = [
  { value: "math", label: "Математика" },
  { value: "info", label: "Информатика" },
  { value: "both", label: "Обе" },
];

export function ContextForm({ autoFocusRegion }: { autoFocusRegion?: boolean }) {
  const learner = useLearner();
  const toast = useToast();
  const regionLabel = useId();
  const save = (patch: Parameters<typeof learner.update>[0]) =>
    learner.update(patch).catch((e) => toast.error(errorMessage(e)));
  const subjectValue: SubjectChoice = learner.bothSubjects ? "both" : learner.subject;
  return (
    <div className="ol-context-form">
      <div className="ol-context-row">
        <span className="ol-context-label" id={`${regionLabel}-grade`}>
          Класс
        </span>
        <Segmented
          label="Класс"
          className="ol-seg-grades"
          value={learner.settings.grade ?? null}
          options={GRADE_OPTIONS}
          onChange={(grade) => void save({ grade })}
        />
      </div>
      <div className="ol-context-row">
        <span className="ol-context-label">Предмет</span>
        <Segmented
          label="Предмет"
          className="ol-seg-subjects"
          value={learner.settings.subject || learner.bothSubjects ? subjectValue : null}
          options={SUBJECT_OPTIONS}
          onChange={(v) =>
            void save(v === "both" ? { bothSubjects: true } : { subject: v, bothSubjects: false })
          }
        />
      </div>
      <div className="ol-context-row">
        <span className="ol-context-label" id={regionLabel}>
          Регион <span className="ol-field-optional">· можно пропустить</span>
        </span>
        <RegionCombobox
          label="Регион"
          labelledBy={regionLabel}
          value={learner.region}
          onChange={(region) => void save({ region })}
          placeholder="Все регионы · начни вводить"
          autoFocus={autoFocusRegion}
        />
        <p className="ol-field-hint">Покажем олимпиады твоего региона и всероссийские</p>
      </div>
    </div>
  );
}

export function ContextDialog({
  open,
  onOpenChange,
  focusRegion,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  focusRegion?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Твой класс и предмет"
      description="По ним подбираем темы, пробники и олимпиады. Изменить можно в любой момент"
      footer={
        <Button size="large" stretched onClick={() => onOpenChange(false)}>
          Готово
        </Button>
      }
    >
      <ContextForm autoFocusRegion={focusRegion} />
    </Dialog>
  );
}

export function ContextChip() {
  const learner = useLearner();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ol-context-chip"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${contextLabel(learner)}. Изменить класс и предмет`}
      >
        <span>{contextLabel(learner)}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      <ContextDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
