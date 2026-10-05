import { Play, RotateCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Button } from "../ui/Primitives";

export function RestartDialog({ open, running, profileName, onClose, onConfirm }: { open: boolean; running: boolean; profileName: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { t } = useTranslation();
  const busy = useControlStore(state => state.busy);
  if (!open) return null;

  return (
    <div className="modalBackdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="modalCard restartDialog" role="dialog" aria-modal="true" aria-labelledby="restart-dialog-title">
        <header>
          <div>
            <h2 id="restart-dialog-title">{t(running ? "restart.title" : "restart.startTitle")}</h2>
            <p>{t("restart.confirmProfile", { name: profileName })}</p>
          </div>
          <Button aria-label={t("actions.close")} onClick={onClose}><X size={15} /></Button>
        </header>
        <p className="restartConfirmationText">{t("restart.description")}</p>
        <footer>
          <Button disabled={busy} onClick={onClose}>{t("actions.cancel")}</Button>
          <Button className="primary" disabled={busy} onClick={() => void onConfirm().then(onClose)}>{running ? <RotateCw size={14}/> : <Play size={14}/>} {t(running ? "actions.applyRestart" : "actions.start")}</Button>
        </footer>
      </section>
    </div>
  );
}
