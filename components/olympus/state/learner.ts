"use client";
import { useMemo } from "react";
import type { Grade, Subject } from "@/lib/domain/types";
import type { CalendarFilters } from "@/lib/ui/calendar";
import { useData, type LocalSettings } from "./data";

export interface Learner {
  grade: Grade;
  subject: Subject;
  /** The child picked «Обе» – don't filter olympiads and mocks by subject. */
  bothSubjects: boolean;
  region: string;
  onboarded: boolean;
  settings: LocalSettings;
  update(patch: LocalSettings): Promise<void>;
  /** Calendar filters that follow the child's context. */
  calendarDefaults: CalendarFilters;
}

/** The child's context: class, subject and region, shared by all sections. */
export function useLearner(): Learner {
  const { state, updateSettings } = useData();
  const s = state.settings;
  return useMemo(() => {
    const grade: Grade = s.grade ?? 4;
    const subject: Subject = s.subject ?? "math";
    const bothSubjects = !!s.bothSubjects;
    const region = s.region ?? "";
    return {
      grade,
      subject,
      bothSubjects,
      region,
      onboarded: !!s.onboarded,
      settings: s,
      update: updateSettings,
      calendarDefaults: {
        grade: s.grade ?? "all",
        subject: bothSubjects || !s.subject ? "all" : s.subject,
        region,
        format: "all",
      },
    };
  }, [s, updateSettings]);
}

export function contextLabel(l: Pick<Learner, "grade" | "subject" | "bothSubjects">): string {
  const subject = l.bothSubjects
    ? "Оба предмета"
    : l.subject === "info"
      ? "Информатика"
      : "Математика";
  return `${l.grade} класс · ${subject}`;
}
