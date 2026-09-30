"use client";
/** Privacy policy, terms of use and «О приложении» (operator details, age rating, support). */
import { CellHeader, CellList, CellSimple } from "@maxhub/max-ui";
import { FileText, Mail, ShieldCheck } from "lucide-react";
import type { LegalDoc } from "@/lib/ui/navigation";
import { PageHeader } from "../shared/layout";
import { useNav } from "../state/navigation";
import { isPlaceholder, LEGAL_EDITION, OPERATOR, PRIVACY, TERMS } from "./texts";

function Value({ value }: { value: string }) {
  return <span className={isPlaceholder(value) ? "ol-placeholder" : undefined}>{value}</span>;
}

function About() {
  const nav = useNav();
  return (
    <>
      <section className="ol-card ol-legal">
        <p>
          «Олимпус» – мини-приложение MAX для подготовки к олимпиадам по математике и информатике
          для 4–6 классов: теория, задачи с проверкой, пробные туры с таймером и календарь олимпиад
          с регионами.
        </p>
        <dl className="ol-about">
          <dt>Возрастная категория</dt>
          <dd>
            <span className="ol-age">{OPERATOR.ageRating}</span>
          </dd>
          <dt>Оператор и правообладатель</dt>
          <dd>
            <Value value={OPERATOR.name} />
          </dd>
          <dt>Реквизиты</dt>
          <dd>
            <Value value={OPERATOR.ids} />
          </dd>
          <dt>Адрес</dt>
          <dd>
            <Value value={OPERATOR.address} />
          </dd>
          <dt>Поддержка</dt>
          <dd>
            <Value value={OPERATOR.email} /> · или напишите чат-боту Олимпуса в MAX
          </dd>
        </dl>
        <p className="ol-muted">
          Даты олимпиад сверяются с официальными сайтами организаторов. Перед участием проверьте
          сроки на сайте олимпиады.
        </p>
      </section>
      <CellList mode="island" header={<CellHeader>Документы</CellHeader>}>
        <CellSimple
          as="button"
          showChevron
          before={<ShieldCheck size={22} aria-hidden />}
          title="Политика конфиденциальности"
          onClick={() => nav.replace({ name: "legal", doc: "privacy" })}
        />
        <CellSimple
          as="button"
          showChevron
          before={<FileText size={22} aria-hidden />}
          title="Условия использования"
          onClick={() => nav.replace({ name: "legal", doc: "terms" })}
        />
        {!isPlaceholder(OPERATOR.email) && (
          <CellSimple
            as="button"
            showChevron
            before={<Mail size={22} aria-hidden />}
            title="Написать в поддержку"
            subtitle={OPERATOR.email}
            onClick={() => {
              window.location.href = `mailto:${OPERATOR.email}`;
            }}
          />
        )}
      </CellList>
    </>
  );
}

export function LegalScreen({ doc }: { doc: LegalDoc }) {
  const title =
    doc === "privacy"
      ? "Политика конфиденциальности"
      : doc === "terms"
        ? "Условия использования"
        : "О приложении";
  const sections = doc === "privacy" ? PRIVACY : doc === "terms" ? TERMS : null;
  return (
    <div className="ol-screen ol-legal-screen">
      <PageHeader back="Назад" title={title} subtitle={sections ? LEGAL_EDITION : undefined} />
      {sections ? (
        <article className="ol-card ol-legal">
          {sections.map((s) => (
            <section key={s.title}>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </section>
          ))}
        </article>
      ) : (
        <About />
      )}
    </div>
  );
}
