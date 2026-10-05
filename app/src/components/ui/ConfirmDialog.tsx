import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./Primitives";

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
  if (!open) return null;
  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onCancel(); }}>
      <section className="modalCard confirmDialog" role="dialog" aria-modal="true">
        <header><div><h2>{title}</h2><p>{text}</p></div><Button aria-label={t("actions.close")} onClick={onCancel}><X size={15}/></Button></header>
        <footer>
          <Button disabled={busy} onClick={onCancel}>{t("actions.cancel")}</Button>
          <Button className={dangerous ? "danger" : "primary"} disabled={busy} onClick={() => void onConfirm()}>{confirmLabel}</Button>
        </footer>
      </section>
    </div>
  );
}
