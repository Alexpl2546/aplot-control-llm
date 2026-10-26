import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FriendlyInlineError } from "../feedback/FriendlyInlineError";
import { Button } from "./Primitives";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  dangerous?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({ open, title, text, confirmLabel, dangerous, busy, onCancel, onConfirm }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const pending = busy || confirming;
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    setError("");
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  const confirm = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setConfirming(true);
    setError("");
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; setConfirming(false); }
  };
  if (!open) return null;
  return (
    <dialog ref={dialog} className="modalBackdrop confirmDialogBackdrop" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={pending || undefined}
      onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (!first) event.preventDefault();
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onMouseDown={event => { if (event.currentTarget === event.target) { event.preventDefault(); if (!pending) onCancel(); } }}>
      <section className="modalCard confirmDialog">
        <header><div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{text}</p></div><Button type="button" aria-label={t("actions.close")} disabled={pending} onClick={onCancel}><X size={15}/></Button></header>
        {error && <div className="dialogBody"><FriendlyInlineError error={error}/></div>}
        <footer>
          <button ref={cancel} type="button" className="uiButton" disabled={pending} onClick={onCancel}>{t("actions.cancel")}</button>
          <Button type="button" className={dangerous ? "danger" : "primary"} disabled={pending} onClick={() => void confirm()}>{confirmLabel}</Button>
        </footer>
      </section>
    </dialog>
  );
}
