"use client";
/** Per-kind forms of the teacher's editor, with human labels instead of raw values. */
import { Button, Switch } from "@maxhub/max-ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ContentRecord,
  Grade,
  Lesson,
  LessonBlock,
  LessonBlockType,
  MockTest,
  Olympiad,
  Subject,
  Task,
  TaskType,
  Topic,
} from "@/lib/domain/types";
import type { FieldErrors } from "@/lib/ui/admin-records";
import { GRADES, SUBJECT_LABEL, TASK_TYPE_LABEL } from "@/lib/ui/format";
import { plural, WORDS } from "@/lib/ui/plural";
import { ChipToggle, Segmented } from "../shared/controls";
import { RegionCombobox } from "../shared/RegionCombobox";
import { AField, control, DateField, fieldId, UploadButton } from "./fields";

export interface EditorProps<T extends ContentRecord> {
  value: T;
  onChange(patch: Partial<T>): void;
  errors: FieldErrors;
  topics: readonly Topic[];
  tasks: readonly Task[];
}

const SUBJECTS: { value: Subject; label: string }[] = [
  { value: "math", label: "Математика" },
  { value: "info", label: "Информатика" },
];

const GRADE_OPTS = GRADES.map((g) => ({ value: g, label: `${g} класс` }));

export const BLOCK_LABEL: Record<LessonBlockType, string> = {
  text: "Текст",
  example: "Пример",
  formula: "Формула",
  image: "Картинка",
  video: "Видео",
  link: "Ссылка",
  list: "Список",
  table: "Таблица",
  code: "Код",
};

const BLOCK_PLACEHOLDER: Partial<Record<LessonBlockType, string>> = {
  text: "Текст урока",
  example: "Разбор примера шаг за шагом",
  formula: "Формула в формате LaTeX, например \\frac{a}{b}",
  image: "https://… или загрузите файл",
  video: "https://… или загрузите файл",
  link: "https://…",
  list: "Каждый пункт с новой строки",
  table: "Столбец 1 | Столбец 2\nЗначение | Значение",
  code: "print('Привет')",
};

function TitleField({
  value,
  onChange,
  error,
  placeholder,
}: {
  value: string;
  onChange(v: string): void;
  error?: string;
  placeholder?: string;
}) {
  return (
    <AField name="title" label="Название" error={error}>
      <input
        {...control("title", error)}
        className="ol-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </AField>
  );
}

function SubjectGrade<T extends Topic | Lesson | Task | MockTest>({
  value,
  onChange,
  errors,
  resetTopic,
}: {
  value: T;
  onChange(patch: Partial<T>): void;
  errors: FieldErrors;
  resetTopic?: boolean;
}) {
  const reset = (resetTopic ? { topicId: "" } : {}) as Partial<T>;
  return (
    <div className="ol-form-row">
      <AField name="subject" label="Предмет" error={errors.subject}>
        <Segmented
          label="Предмет"
          value={value.subject}
          options={SUBJECTS}
          onChange={(subject) => onChange({ subject, ...reset } as Partial<T>)}
        />
      </AField>
      <AField name="grade" label="Класс" error={errors.grade}>
        <Segmented
          label="Класс"
          value={value.grade}
          options={GRADE_OPTS}
          onChange={(grade: Grade) => onChange({ grade, ...reset } as Partial<T>)}
        />
      </AField>
    </div>
  );
}

function TopicSelect({
  value,
  onChange,
  error,
  topics,
}: {
  value: Lesson | Task;
  onChange(id: string): void;
  error?: string;
  topics: readonly Topic[];
}) {
  const options = topics
    .filter((t) => t.grade === value.grade && t.subject === value.subject)
    .sort((a, b) => a.order - b.order);
  return (
    <AField
      name="topicId"
      label="Тема"
      error={error}
      hint={
        options.length
          ? undefined
          : "Для этого класса и предмета пока нет тем – сначала создайте тему"
      }
    >
      <span className="ol-select">
        <select
          {...control("topicId", error)}
          value={value.topicId}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Выберите тему</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.order}. {t.title}
            </option>
          ))}
        </select>
      </span>
    </AField>
  );
}

function OrderField({
  value,
  onChange,
  error,
  label = "Номер по порядку",
}: {
  value: number;
  onChange(v: number): void;
  error?: string;
  label?: string;
}) {
  return (
    <AField name="order" label={label} error={error} hint="Чем меньше номер, тем выше в списке">
      <input
        {...control("order", error)}
        className="ol-input ol-input--short"
        type="number"
        min={1}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </AField>
  );
}

export function OlympiadEditor({ value, onChange, errors }: EditorProps<Olympiad>) {
  const both = (value.subjects?.length ?? 0) > 1;
  const school = value.registrationType === "school";
  const [scope, setScope] = useState<"russia" | "region">(value.region ? "region" : "russia");
  return (
    <>
      <TitleField
        value={value.title}
        onChange={(title) => onChange({ title })}
        error={errors.title}
        placeholder="Например: Олимпиада «Бельчонок» – математика"
      />
      <AField name="subject" label="Предмет" error={errors.subject}>
        <Segmented
          label="Предмет"
          value={both ? "both" : value.subject}
          options={[...SUBJECTS, { value: "both" as const, label: "Оба" }]}
          onChange={(v) =>
            v === "both"
              ? onChange({ subject: value.subject, subjects: ["math", "info"] })
              : onChange({ subject: v, subjects: undefined })
          }
        />
      </AField>
      <AField name="grades" label="Для каких классов" error={errors.grades}>
        <div className="ol-chips" id={fieldId("grades")}>
          {GRADES.map((g) => (
            <ChipToggle
              key={g}
              checked={value.grades.includes(g)}
              onChange={(on) =>
                onChange({
                  grades: (on
                    ? [...value.grades, g]
                    : value.grades.filter((x) => x !== g)
                  ).sort() as Grade[],
                })
              }
            >
              {g} класс
            </ChipToggle>
          ))}
        </div>
      </AField>
      <div className="ol-form-row">
        <AField name="format" label="Как проходит" error={errors.format}>
          <Segmented
            label="Как проходит"
            value={value.format}
            options={[
              { value: "online" as const, label: "Онлайн" },
              { value: "offline" as const, label: "Очно" },
            ]}
            onChange={(format) => onChange({ format })}
          />
        </AField>
        <AField
          name="scope"
          label="Кто может участвовать"
          hint={
            scope === "russia" && value.format === "offline"
              ? "Очно, но для всей России: проходит во многих городах (например, «Кенгуру»)"
              : undefined
          }
        >
          <Segmented
            label="Кто может участвовать"
            value={scope}
            options={[
              { value: "russia" as const, label: "Вся Россия" },
              { value: "region" as const, label: "Один регион" },
            ]}
            onChange={(v) => {
              setScope(v);
              if (v === "russia") onChange({ region: "" });
            }}
          />
        </AField>
      </div>
      {scope === "region" && (
        <AField
          name="region"
          label="Регион"
          error={errors.region}
          hint="Олимпиаду увидят дети, выбравшие этот регион (и все, кто регион не выбирал)"
        >
          <RegionCombobox
            id={fieldId("region")}
            label="Регион"
            value={value.region}
            onChange={(region) => onChange({ region })}
            placeholder="Начните вводить регион"
            invalid={!!errors.region}
          />
        </AField>
      )}
      <AField
        name="stage"
        label="Этап"
        optional
        error={errors.stage}
        hint="Например: «Школьный этап», «Отборочный тур»"
      >
        <input
          {...control("stage")}
          className="ol-input"
          value={value.stage ?? ""}
          onChange={(e) => onChange({ stage: e.target.value || undefined })}
        />
      </AField>

      <h3 className="ol-form-section">Как участвовать</h3>
      <AField name="registrationType" label="Регистрация" error={errors.registrationType}>
        <Segmented
          label="Регистрация"
          value={value.registrationType ?? "link"}
          options={[
            { value: "link" as const, label: "На сайте организатора" },
            { value: "school" as const, label: "Записывает школа" },
          ]}
          onChange={(registrationType) => onChange({ registrationType })}
        />
      </AField>
      <AField
        name="url"
        label={school ? "Ссылка на правила участия" : "Ссылка на регистрацию"}
        error={errors.url}
        hint={
          !value.url
            ? "Можно добавить позже – пока дети увидят «Ссылку на регистрацию скоро добавим»"
            : school
              ? "Страница, где объяснено, как участвовать"
              : "Сюда ребёнок попадёт по кнопке «Зарегистрироваться»"
        }
      >
        <input
          {...control("url", errors.url)}
          className="ol-input"
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={value.url}
          onChange={(e) => onChange({ url: e.target.value.trim() })}
        />
      </AField>
      <div className="ol-form-row">
        <DateField
          name="registrationStart"
          label="Начало регистрации"
          optional
          value={value.registrationStart}
          error={errors.registrationStart}
          onChange={(v) => onChange({ registrationStart: v || undefined })}
        />
        <DateField
          name="deadline"
          label="Регистрация до"
          value={value.deadline}
          error={errors.deadline}
          expectedLabel="Срок ещё не объявлен"
          hint={school ? "Можно не указывать: школа сама подаёт списки" : undefined}
          onChange={(deadline) => onChange({ deadline: deadline ?? "" })}
        />
      </div>
      <div className="ol-form-row">
        <DateField
          name="date"
          label="Дата олимпиады"
          value={value.date}
          error={errors.date}
          expectedLabel="Дата ещё не объявлена"
          onChange={(date) => onChange({ date: date ?? "" })}
        />
        <DateField
          name="dateEnd"
          label="Последний день"
          optional
          value={value.dateEnd}
          error={errors.dateEnd}
          hint="Для многодневных олимпиад"
          onChange={(v) => onChange({ dateEnd: v || undefined })}
        />
      </div>
      <AField name="price" label="Стоимость участия, ₽" error={errors.price} hint="0 – бесплатно">
        <input
          {...control("price", errors.price)}
          className="ol-input ol-input--short"
          type="number"
          min={0}
          value={value.price ?? 0}
          onChange={(e) => onChange({ price: Number(e.target.value) })}
        />
      </AField>
      <AField name="description" label="Описание для детей" optional error={errors.description}>
        <textarea
          {...control("description")}
          className="ol-textarea"
          value={value.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value || undefined })}
        />
      </AField>
      <div className="ol-form-row">
        <AField
          name="source"
          label="Где проверены даты"
          optional
          error={errors.source}
          hint="Официальная страница – покажем «источник» на карточке"
        >
          <input
            {...control("source", errors.source)}
            className="ol-input"
            type="url"
            placeholder="https://…"
            value={value.source ?? ""}
            onChange={(e) => onChange({ source: e.target.value.trim() || undefined })}
          />
        </AField>
        <DateField
          name="verifiedAt"
          label="Когда проверено"
          optional
          value={value.verifiedAt}
          onChange={(v) => onChange({ verifiedAt: v || undefined })}
        />
      </div>
      <AField name="image" label="Картинка карточки" optional error={errors.image}>
        <div className="ol-inline">
          <input
            {...control("image", errors.image)}
            className="ol-input"
            type="url"
            placeholder="https://…"
            value={value.image ?? ""}
            onChange={(e) => onChange({ image: e.target.value.trim() || undefined })}
          />
          <UploadButton
            accept="image/png,image/jpeg,image/webp"
            onUploaded={(image) => onChange({ image })}
            label="Загрузить"
          />
        </div>
      </AField>
      <label className="ol-switch-row">
        <Switch
          checked={!!value.featured}
          onChange={(e) => onChange({ featured: e.target.checked })}
        />
        <span>
          <b>Выделить карточку</b>
          <small>Олимпиада будет первой в списке с пометкой «Рекомендуем»</small>
        </span>
      </label>
      <label className="ol-switch-row">
        <Switch
          checked={!!value.demo}
          onChange={(e) => onChange({ demo: e.target.checked || undefined })}
        />
        <span>
          <b>Это пример, а не настоящая олимпиада</b>
          <small>Дети увидят пометку «Пример»</small>
        </span>
      </label>
    </>
  );
}

export function TopicEditor({ value, onChange, errors }: EditorProps<Topic>) {
  return (
    <>
      <TitleField
        value={value.title}
        onChange={(title) => onChange({ title })}
        error={errors.title}
        placeholder="Например: Чётность и нечётность"
      />
      <SubjectGrade value={value} onChange={onChange} errors={errors} />
      <OrderField
        value={value.order}
        onChange={(order) => onChange({ order })}
        error={errors.order}
      />
      <AField name="description" label="Коротко о теме" optional error={errors.description}>
        <textarea
          {...control("description")}
          className="ol-textarea"
          value={value.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </AField>
    </>
  );
}

function BlockEditor({
  block,
  index,
  count,
  error,
  onChange,
  onMove,
  onRemove,
}: {
  block: LessonBlock;
  index: number;
  count: number;
  error?: string;
  onChange(b: LessonBlock): void;
  onMove(delta: number): void;
  onRemove(): void;
}) {
  const media = block.type === "image" || block.type === "video" || block.type === "link";
  const name = `blocks.${index}`;
  return (
    <div className={"ol-block-editor" + (error ? " ol-field--error" : "")} data-field={name}>
      <div className="ol-block-head">
        <b>Блок {index + 1}</b>
        <span className="ol-select ol-select--small">
          <select
            aria-label={`Тип блока ${index + 1}`}
            value={block.type}
            onChange={(e) => onChange({ ...block, type: e.target.value as LessonBlockType })}
          >
            {(Object.keys(BLOCK_LABEL) as LessonBlockType[]).map((t) => (
              <option key={t} value={t}>
                {BLOCK_LABEL[t]}
              </option>
            ))}
          </select>
        </span>
        <button
          type="button"
          className="ol-icon-btn"
          aria-label={`Поднять блок ${index + 1}`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={18} aria-hidden />
        </button>
        <button
          type="button"
          className="ol-icon-btn"
          aria-label={`Опустить блок ${index + 1}`}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={18} aria-hidden />
        </button>
        <button
          type="button"
          className="ol-icon-btn"
          aria-label={`Удалить блок ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 size={18} aria-hidden />
        </button>
      </div>
      <textarea
        {...control(name, error)}
        aria-label={`Содержание блока ${index + 1}`}
        className={"ol-textarea" + (block.type === "code" ? " ol-textarea--code" : "")}
        value={block.value}
        placeholder={BLOCK_PLACEHOLDER[block.type]}
        onChange={(e) => onChange({ ...block, value: e.target.value })}
      />
      {media && (
        <div className="ol-inline">
          <input
            className="ol-input"
            aria-label={`Подпись блока ${index + 1}`}
            placeholder="Подпись (необязательно)"
            value={block.caption ?? ""}
            onChange={(e) => onChange({ ...block, caption: e.target.value || undefined })}
          />
          {block.type !== "link" && (
            <UploadButton
              accept={block.type === "image" ? "image/png,image/jpeg,image/webp" : "video/mp4"}
              onUploaded={(url) => onChange({ ...block, value: url })}
              label="Загрузить"
            />
          )}
        </div>
      )}
      {error && (
        <p className="ol-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function LessonEditor({ value, onChange, errors, topics }: EditorProps<Lesson>) {
  const blocks = value.blocks ?? [];
  const setBlocks = (next: LessonBlock[]) => onChange({ blocks: next });
  return (
    <>
      <TitleField
        value={value.title}
        onChange={(title) => onChange({ title })}
        error={errors.title}
        placeholder="Например: Главная идея"
      />
      <SubjectGrade value={value} onChange={onChange} errors={errors} resetTopic />
      <TopicSelect
        value={value}
        topics={topics}
        error={errors.topicId}
        onChange={(topicId) => onChange({ topicId })}
      />
      <OrderField
        value={value.order}
        onChange={(order) => onChange({ order })}
        error={errors.order}
        label="Номер урока в теме"
      />
      <h3 className="ol-form-section" id={fieldId("blocks")}>
        Содержание урока
      </h3>
      {errors.blocks && (
        <p className="ol-field-error" role="alert">
          {errors.blocks}
        </p>
      )}
      {blocks.map((b, i) => (
        <BlockEditor
          key={i}
          block={b}
          index={i}
          count={blocks.length}
          error={errors[`blocks.${i}`]}
          onChange={(nb) => setBlocks(blocks.map((x, j) => (j === i ? nb : x)))}
          onMove={(d) => {
            const next = [...blocks];
            [next[i], next[i + d]] = [next[i + d], next[i]];
            setBlocks(next);
          }}
          onRemove={() => setBlocks(blocks.filter((_, j) => j !== i))}
        />
      ))}
      <Button
        variant="secondary"
        iconBefore={<Plus size={18} aria-hidden />}
        onClick={() => setBlocks([...blocks, { type: "text", value: "" }])}
      >
        Добавить блок
      </Button>
    </>
  );
}

export function TaskEditor({ value, onChange, errors, topics }: EditorProps<Task>) {
  const tests = value.tests ?? [];
  return (
    <>
      <TitleField
        value={value.title}
        onChange={(title) => onChange({ title })}
        error={errors.title}
        placeholder="Например: Чётные числа до 6"
      />
      <SubjectGrade value={value} onChange={onChange} errors={errors} resetTopic />
      <TopicSelect
        value={value}
        topics={topics}
        error={errors.topicId}
        onChange={(topicId) => onChange({ topicId })}
      />
      <AField name="type" label="Как ребёнок отвечает" error={errors.type}>
        <Segmented
          label="Как ребёнок отвечает"
          value={value.type}
          options={(Object.keys(TASK_TYPE_LABEL) as TaskType[]).map((t) => ({
            value: t,
            label: TASK_TYPE_LABEL[t],
          }))}
          onChange={(type) => onChange({ type })}
        />
      </AField>
      <AField
        name="prompt"
        label="Условие"
        error={errors.prompt}
        hint="Код в условии оформляйте между строками ``` – он покажется моноширинным блоком"
      >
        <textarea
          {...control("prompt", errors.prompt)}
          className="ol-textarea"
          value={value.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </AField>
      {value.type === "number" && (
        <AField
          name="answer"
          label="Правильный ответ (число)"
          error={errors.answer}
          hint="Дети могут писать и «0,5», и «0.5»"
        >
          <input
            {...control("answer", errors.answer)}
            className="ol-input ol-input--short"
            inputMode="decimal"
            value={value.answer ?? ""}
            onChange={(e) => onChange({ answer: e.target.value })}
          />
        </AField>
      )}
      <AField
        name="solution"
        label="Разбор решения"
        error={errors.solution}
        hint="Ребёнок увидит его после попытки или по кнопке «Посмотреть решение»"
      >
        <textarea
          {...control("solution", errors.solution)}
          className="ol-textarea"
          value={value.solution}
          onChange={(e) => onChange({ solution: e.target.value })}
        />
      </AField>
      <AField
        name="hint"
        label="Подсказка"
        optional
        error={errors.hint}
        hint="Первый шаг к решению, без ответа"
      >
        <textarea
          {...control("hint")}
          className="ol-textarea"
          value={value.hint ?? ""}
          onChange={(e) => onChange({ hint: e.target.value })}
        />
      </AField>
      <div className="ol-form-row">
        <AField name="points" label="Баллы" error={errors.points}>
          <input
            {...control("points", errors.points)}
            className="ol-input ol-input--short"
            type="number"
            min={0}
            value={value.points ?? 1}
            onChange={(e) => onChange({ points: Number(e.target.value) })}
          />
        </AField>
        <OrderField
          value={value.order}
          onChange={(order) => onChange({ order })}
          error={errors.order}
          label="Номер задачи в теме"
        />
      </div>
      {value.type === "code" && (
        <>
          <h3 className="ol-form-section" id={fieldId("tests")}>
            Тесты программы
          </h3>
          <p className="ol-field-hint">
            Первый тест дети увидят как пример. Остальные скрыты и нужны для проверки.
          </p>
          {errors.tests && (
            <p className="ol-field-error" role="alert">
              {errors.tests}
            </p>
          )}
          {tests.map((t, i) => (
            <div className="ol-block-editor ol-form-row" key={i} data-field={`tests.${i}`}>
              <AField name={`tests.${i}.input`} label={`Вход · тест ${i + 1}`}>
                <textarea
                  {...control(`tests.${i}.input`)}
                  className="ol-textarea ol-textarea--code"
                  value={t.input}
                  onChange={(e) =>
                    onChange({
                      tests: tests.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)),
                    })
                  }
                />
              </AField>
              <AField name={`tests.${i}`} label="Правильный вывод" error={errors[`tests.${i}`]}>
                <textarea
                  {...control(`tests.${i}`, errors[`tests.${i}`])}
                  className="ol-textarea ol-textarea--code"
                  value={t.output}
                  onChange={(e) =>
                    onChange({
                      tests: tests.map((x, j) => (j === i ? { ...x, output: e.target.value } : x)),
                    })
                  }
                />
              </AField>
              <Button
                size="small"
                variant="ghost"
                iconBefore={<Trash2 size={16} aria-hidden />}
                onClick={() => onChange({ tests: tests.filter((_, j) => j !== i) })}
              >
                Удалить тест
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            iconBefore={<Plus size={18} aria-hidden />}
            onClick={() => onChange({ tests: [...tests, { input: "", output: "" }] })}
          >
            Добавить тест
          </Button>
        </>
      )}
    </>
  );
}

export function MockEditor({ value, onChange, errors, topics, tasks }: EditorProps<MockTest>) {
  const [query, setQuery] = useState("");
  const available = useMemo(
    () =>
      tasks
        .filter((t) => t.grade === value.grade && t.subject === value.subject)
        .filter(
          (t) => !query || `${t.title} ${t.prompt}`.toLowerCase().includes(query.toLowerCase()),
        ),
    [tasks, value.grade, value.subject, query],
  );
  const toggle = (id: string, on: boolean) =>
    onChange({ taskIds: on ? [...value.taskIds, id] : value.taskIds.filter((x) => x !== id) });
  // Chosen tasks that are not in the list below: deleted ones and ones of another class/subject.
  const missing = value.taskIds.filter((id) => !tasks.some((t) => t.id === id));
  const foreign = tasks.filter(
    (t) => value.taskIds.includes(t.id) && (t.grade !== value.grade || t.subject !== value.subject),
  );
  return (
    <>
      <TitleField
        value={value.title}
        onChange={(title) => onChange({ title })}
        error={errors.title}
        placeholder="Например: Пробный тур · 5 класс"
      />
      <SubjectGrade
        value={value}
        onChange={(p) => onChange({ ...p, taskIds: [] })}
        errors={errors}
      />
      <div className="ol-form-row">
        <AField
          name="olympiad"
          label="К какой олимпиаде готовит"
          optional
          error={errors.olympiad}
          hint="По этому названию дети фильтруют пробники"
        >
          <input
            {...control("olympiad")}
            className="ol-input"
            value={value.olympiad}
            onChange={(e) => onChange({ olympiad: e.target.value })}
          />
        </AField>
        <AField name="minutes" label="Время, минут" error={errors.minutes}>
          <input
            {...control("minutes", errors.minutes)}
            className="ol-input ol-input--short"
            type="number"
            min={1}
            value={value.minutes}
            onChange={(e) => onChange({ minutes: Number(e.target.value) })}
          />
        </AField>
      </div>
      <label className="ol-switch-row">
        <Switch
          checked={!!value.randomize}
          onChange={(e) => onChange({ randomize: e.target.checked })}
        />
        <span>
          <b>Каждый раз новый набор заданий</b>
          <small>Задания выбираются случайно из банка ниже</small>
        </span>
      </label>
      {value.randomize && (
        <AField name="taskCount" label="Заданий в одной попытке" error={errors.taskCount}>
          <input
            {...control("taskCount", errors.taskCount)}
            className="ol-input ol-input--short"
            type="number"
            min={1}
            max={value.taskIds.length || 1}
            value={value.taskCount ?? 10}
            onChange={(e) => onChange({ taskCount: Number(e.target.value) })}
          />
        </AField>
      )}
      <h3 className="ol-form-section" id={fieldId("taskIds")}>
        Задания · выбрано {plural(value.taskIds.length, WORDS.task)}
      </h3>
      {errors.taskIds && (
        <p className="ol-field-error" role="alert">
          {errors.taskIds}
        </p>
      )}
      {(missing.length > 0 || foreign.length > 0) && (
        <ul className="ol-task-problems" aria-label="Задания, которые мешают сохранить пробник">
          {missing.map((id) => (
            <li key={id}>
              <span>
                <b>Задание «{id}» удалено.</b> Уберите его из пробника или восстановите в
                «Удалённых».
              </span>
              <Button size="small" variant="secondary" onClick={() => toggle(id, false)}>
                Убрать
              </Button>
            </li>
          ))}
          {foreign.map((t) => (
            <li key={t.id}>
              <span>
                <b>«{t.title}»</b> – для {t.grade} класса, {SUBJECT_LABEL[t.subject].toLowerCase()}.
                В этом пробнике такие задания не покажутся.
              </span>
              <Button size="small" variant="secondary" onClick={() => toggle(t.id, false)}>
                Убрать
              </Button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="ol-input"
        aria-label="Найти задание"
        placeholder="Найти задание"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="ol-task-picker">
        {available.map((t) => (
          <li key={t.id}>
            <label>
              <input
                type="checkbox"
                checked={value.taskIds.includes(t.id)}
                onChange={(e) => toggle(t.id, e.target.checked)}
              />
              <span>
                <b>
                  {topics.find((x) => x.id === t.topicId)?.title ?? "Без темы"} · {t.title}
                </b>
                <small>{t.prompt}</small>
              </span>
              <em>{plural(t.points ?? 1, WORDS.point)}</em>
            </label>
          </li>
        ))}
        {!available.length && (
          <li className="ol-muted">
            {query
              ? "Ничего не нашли."
              : `Заданий для «${SUBJECT_LABEL[value.subject]} · ${value.grade} класс» пока нет.`}
          </li>
        )}
      </ul>
    </>
  );
}
