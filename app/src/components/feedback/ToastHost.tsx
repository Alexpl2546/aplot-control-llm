import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import type { AppNotice } from "../../types/app";

const icons = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle } as const;

export function ToastHost() {
  const notices = useControlStore(state => state.notices);
  const dismissNotice = useControlStore(state => state.dismissNotice);
  return <div className="toastHost" aria-live="polite">{notices.map(notice => <Toast key={notice.id} notice={notice} dismiss={() => dismissNotice(notice.id)}/>)}</div>;
}

/** Hover or focus pauses the countdown, so an action like "Undo" is never snatched away mid-reach. */
function Toast({ notice, dismiss }: { notice: AppNotice; dismiss: () => void }) {
  const { t } = useTranslation();
  const Icon = icons[notice.kind];
  const duration = notice.durationMs ?? (notice.kind === "error" ? 7000 : 4000);
  const [paused, setPaused] = useState(false);
  const left = useRef(duration);
  const started = useRef(Date.now());
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (paused) { left.current -= Date.now() - started.current; return; }
    started.current = Date.now();
    const timer = window.setTimeout(dismiss, Math.max(400, left.current));
    return () => window.clearTimeout(timer);
  }, [paused, notice.id]);
  const act = async () => {
    if (!notice.action || running) return;
    setRunning(true);
    try { await notice.action.run(); dismiss(); }
    catch (error) { useControlStore.getState().notify("error", String(error)); dismiss(); }
  };
  return <div className={`toast ${notice.kind}${notice.action ? " hasAction" : ""}${paused ? " isPaused" : ""}`} style={{ ["--toast-ms" as string]: `${duration}ms` }}
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}>
    <Icon size={16}/><span>{notice.message}</span>
    {notice.action && <button type="button" className="toastAction" disabled={running} onClick={() => void act()}>{notice.action.label}</button>}
    <button type="button" className="toastClose" aria-label={t("actions.close")} onClick={dismiss}><X size={13}/></button>
    {notice.action && <i className="toastTimer" aria-hidden="true"/>}
  </div>;
}
