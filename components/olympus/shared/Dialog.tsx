"use client";
/**
 * Modal dialog (radix-ui: focus trap, Esc, aria) styled with MAX UI tokens.
 * Portals render outside the MaxUI root, so the content is wrapped in MaxUI again.
 * On phones it opens as a bottom sheet.
 */
import { Dialog as D } from "radix-ui";
import { Button, MaxUI, useAppearance } from "@maxhub/max-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row at the bottom. */
  footer?: ReactNode;
  size?: "normal" | "wide";
  /** Prevent closing by overlay click / Esc while an action is running. */
  busy?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "normal",
  busy,
}: DialogProps) {
  const appearance = useAppearance();
  return (
    <D.Root open={open} onOpenChange={(v) => (busy && !v ? undefined : onOpenChange(v))}>
      <D.Portal>
        <D.Overlay className="ol-dialog-overlay" />
        <D.Content
          className={`ol-dialog ol-dialog--${size}`}
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onPointerDownOutside={(e) => busy && e.preventDefault()}
        >
          <MaxUI
            platform={appearance.platform}
            colorScheme={appearance.colorScheme}
            className="ol-dialog-root"
          >
            <div className="ol-dialog-head">
              <D.Title className="ol-dialog-title">{title}</D.Title>
              <D.Close asChild>
                <button type="button" className="ol-icon-btn" aria-label="Закрыть" disabled={busy}>
                  <X size={20} aria-hidden />
                </button>
              </D.Close>
            </div>
            {description ? (
              <D.Description className="ol-dialog-desc">{description}</D.Description>
            ) : (
              <D.Description className="ol-visually-hidden">
                {typeof title === "string" ? title : "Окно"}
              </D.Description>
            )}
            {children && <div className="ol-dialog-body">{children}</div>}
            {footer && <div className="ol-dialog-footer">{footer}</div>}
          </MaxUI>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm(): void;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Отмена",
  destructive,
  pending,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      busy={pending}
      footer={
        <>
          <Button
            type="button"
            size="large"
            variant="secondary"
            stretched
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="large"
            variant={destructive ? "destructive" : "primary"}
            stretched
            loading={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
