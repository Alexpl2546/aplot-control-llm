import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react";
import { useEffect } from "react";
import { useControlStore } from "../../store/control";
import type { AppNotice } from "../../types/app";

const icons = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle } as const;

export function ToastHost() {
  const { notices, dismissNotice } = useControlStore();
  return <div className="toastHost" aria-live="polite">{notices.map(notice => <Toast key={notice.id} notice={notice} dismiss={() => dismissNotice(notice.id)}/>)}</div>;
}

function Toast({ notice, dismiss }: { notice: AppNotice; dismiss: () => void }) {
  const Icon = icons[notice.kind];
  useEffect(() => { const timer = window.setTimeout(dismiss, notice.kind === "error" ? 7000 : 4000); return () => window.clearTimeout(timer); }, [notice.id, notice.kind]);
  return <div className={`toast ${notice.kind}`}><Icon size={16}/><span>{notice.message}</span><button aria-label="×" onClick={dismiss}><X size={13}/></button></div>;
}
