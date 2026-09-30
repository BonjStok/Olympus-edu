"use client";
/** First run: one friendly screen – class, subject, optional region. */
import { Button } from "@maxhub/max-ui";
import { useId, useState } from "react";
import type { Grade, Subject } from "@/lib/domain/types";
import { errorMessage } from "@/lib/client/api";
import { haptic } from "@/lib/client/max-bridge";
import { Segmented } from "../shared/controls";
import { GRADE_OPTIONS, SUBJECT_OPTIONS } from "../shared/ContextPicker";
import { RegionCombobox } from "../shared/RegionCombobox";
import { useLearner } from "../state/learner";
import { useToast } from "../state/toast";

export function Onboarding() {
  const learner = useLearner();
  const toast = useToast();
  const regionLabel = useId();
  const [grade, setGrade] = useState<Grade | null>(learner.settings.grade ?? null);
  const [subject, setSubject] = useState<Subject | "both" | null>(null);
  const [region, setRegion] = useState(learner.region);
  const [saving, setSaving] = useState(false);
  const ready = grade !== null && subject !== null;

  const finish = async (skip: boolean) => {
    setSaving(true);
    haptic.impact("light");
    const patch = skip
      ? { onboarded: true, ...(grade ? { grade } : {}) }
      : {
          onboarded: true,
          grade: grade ?? learner.grade,
          region,
          ...(subject === "both"
            ? { bothSubjects: true, subject: learner.subject }
            : { bothSubjects: false, subject: subject ?? learner.subject }),
        };
    try {
      await learner.update(patch);
    } catch (e) {
      // Saved on this device anyway; the server copy will follow next time.
      toast.info(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ol-onboarding" aria-labelledby="onboarding-title">
      <div className="ol-onboarding-card">
        <img
          className="ol-onboarding-logo"
          src="/olympus-icon-ui.webp"
          alt=""
          width={72}
          height={72}
        />
        <h1 id="onboarding-title">Привет! Я Олимпус</h1>
        <p className="ol-onboarding-lead">
          Помогу подготовиться к олимпиадам по математике и информатике: теория, задачи, пробные
          туры и календарь олимпиад.
        </p>

        <div className="ol-onboarding-q">
          <h2>В каком ты классе?</h2>
          <Segmented
            label="Класс"
            className="ol-seg-grades"
            value={grade}
            options={GRADE_OPTIONS.map((o) => ({ ...o, label: `${o.value} класс` }))}
            onChange={(g) => {
              haptic.selection();
              setGrade(g);
            }}
          />
        </div>

        <div className="ol-onboarding-q">
          <h2>Что будем изучать?</h2>
          <Segmented
            label="Предмет"
            className="ol-seg-subjects"
            value={subject}
            options={SUBJECT_OPTIONS}
            onChange={(v) => {
              haptic.selection();
              setSubject(v);
            }}
          />
        </div>

        <div className="ol-onboarding-q">
          <h2 id={regionLabel}>
            Где ты учишься? <span className="ol-field-optional">можно пропустить</span>
          </h2>
          <RegionCombobox
            label="Регион"
            labelledBy={regionLabel}
            value={region}
            onChange={setRegion}
            placeholder="Все регионы · начни вводить"
          />
          <p className="ol-field-hint">Покажем олимпиады твоего региона и всероссийские</p>
        </div>

        <div className="ol-onboarding-actions">
          <Button
            size="large"
            stretched
            disabled={!ready}
            loading={saving}
            onClick={() => void finish(false)}
          >
            {ready ? "Начать" : "Выбери класс и предмет"}
          </Button>
          <Button
            size="large"
            stretched
            variant="ghost"
            disabled={saving}
            onClick={() => void finish(true)}
          >
            Пропустить
          </Button>
        </div>
        <p className="ol-onboarding-note">
          Выбор запомним – поменять его можно в любой момент в шапке приложения
        </p>
      </div>
    </section>
  );
}
