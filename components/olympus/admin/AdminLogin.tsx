"use client";
/** Teacher sign-in form (also shown inside the editor when the teacher session expired). */
import { Button } from "@maxhub/max-ui";
import { useId, useState } from "react";
import { errorMessage } from "@/lib/client/api";
import { useData } from "../state/data";

export function AdminLoginForm({ onSuccess }: { onSuccess?: () => void }) {
  const data = useData();
  const id = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!password) return setError("Введите пароль");
    setPending(true);
    setError(null);
    try {
      await data.api.call("admin-login", { password });
      await data.load();
      setPassword("");
      onSuccess?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="ol-admin-login-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={"ol-field" + (error ? " ol-field--error" : "")}>
        <label className="ol-field-label" htmlFor={id}>
          Пароль учителя
        </label>
        <input
          id={id}
          className="ol-input"
          type="password"
          autoComplete="current-password"
          value={password}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
        {error ? (
          <p className="ol-field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        ) : (
          <p className="ol-field-hint" id={`${id}-hint`}>
            Пароль выдаёт администратор сервера Олимпуса
          </p>
        )}
      </div>
      <Button type="submit" size="large" stretched loading={pending}>
        Войти
      </Button>
    </form>
  );
}

export function AdminLogin({ onBack }: { onBack(): void }) {
  return (
    <section className="ol-card ol-admin-login" aria-labelledby="admin-login-title">
      <h2 id="admin-login-title">Вход для учителя</h2>
      <p>
        Здесь можно добавлять олимпиады, темы, уроки, задания и пробники. Изменения увидят все дети
        после публикации.
      </p>
      <AdminLoginForm />
      <Button variant="ghost" size="medium" onClick={onBack}>
        Вернуться в приложение
      </Button>
    </section>
  );
}
