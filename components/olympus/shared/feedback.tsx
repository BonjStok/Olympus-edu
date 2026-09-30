"use client";
/** Empty, loading and error states; the toast viewport. */
import { Button, Spinner } from "@maxhub/max-ui";
import { AlertCircle, CheckCircle2, Info, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useToast, useToastItems } from "../state/toast";

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ol-empty">
      {icon && (
        <span className="ol-empty-icon" aria-hidden>
          {icon}
        </span>
      )}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action && <div className="ol-empty-action">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Загружаем…" }: { label?: string }) {
  return (
    <div className="ol-loading" role="status" aria-live="polite">
      <Spinner size={28} appearance="themed" />
      <span>{label}</span>
    </div>
  );
}

/** Inline error with an optional retry – for failures that block a screen or a block. */
export function ErrorBanner({
  title = "Что-то пошло не так",
  message,
  onRetry,
  retrying,
  onClose,
  action,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  onClose?: () => void;
  /** A different way out instead of retrying (e.g. «К пробникам» when the attempt is gone). */
  action?: ReactNode;
}) {
  return (
    <div className="ol-error-banner" role="alert">
      <AlertCircle size={22} aria-hidden className="ol-error-banner-icon" />
      <div className="ol-error-banner-text">
        <b>{title}</b>
        <p>{message}</p>
        {action}
        {onRetry && !action && (
          <Button
            size="small"
            variant="secondary"
            loading={retrying}
            onClick={onRetry}
            iconBefore={<RotateCcw size={16} aria-hidden />}
          >
            Попробовать ещё раз
          </Button>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          className="ol-icon-btn"
          aria-label="Скрыть сообщение"
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>
      )}
    </div>
  );
}

export function ToastViewport() {
  const items = useToastItems();
  const toast = useToast();
  return (
    <div className="ol-toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div
          key={t.id}
          className={`ol-toast ol-toast--${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          {t.kind === "success" ? (
            <CheckCircle2 size={20} aria-hidden />
          ) : t.kind === "error" ? (
            <AlertCircle size={20} aria-hidden />
          ) : (
            <Info size={20} aria-hidden />
          )}
          <span className="ol-toast-text">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="ol-toast-action"
              onClick={() => {
                t.action?.onClick();
                toast.dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="ol-icon-btn ol-toast-close"
            aria-label="Закрыть уведомление"
            onClick={() => toast.dismiss(t.id)}
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
