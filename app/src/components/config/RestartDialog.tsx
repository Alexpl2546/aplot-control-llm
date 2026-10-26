import { Play, RotateCw, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Primitives";

interface RestartDialogProps {
  open: boolean;
  running: boolean;
  profileName: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  pending?: boolean;
}

export function RestartDialog(props: RestartDialogProps) {
  return props.open ? <OpenRestartDialog {...props}/> : null;
}

function OpenRestartDialog({ running, profileName, onClose, onConfirm, pending = false }: RestartDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return <dialog ref={ref} className="modalCard restartDialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header>
      <div><h2 id={titleId}>{t(running ? "restart.title" : "restart.startTitle")}</h2><p>{t("restart.confirmProfile", { name: profileName })}</p></div>
      <Button aria-label={t("actions.close")} disabled={pending} onClick={onClose}><X size={15}/></Button>
    </header>
    <p className="restartConfirmationText">{t("restart.description")}</p>
    <footer>
      <Button disabled={pending} onClick={onClose}>{t("actions.cancel")}</Button>
      <Button className="primary" disabled={pending} onClick={() => void onConfirm()}>{running ? <RotateCw size={14}/> : <Play size={14}/>} {t(running ? "actions.applyRestart" : "actions.start")}</Button>
    </footer>
  </dialog>;
}
