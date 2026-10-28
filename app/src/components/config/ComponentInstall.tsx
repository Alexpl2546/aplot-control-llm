import { useEffect, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "../ui/Primitives";
import { AgentIcon } from "../../features/agent/AgentIdentity";
import { metaFor } from "./componentCatalog";
import { componentErrorKey, loadComponentCatalog, runComponentJobs, useComponentJobs } from "./componentJobs";
import "./ComponentManager.css";

export function ComponentIcon({ id, size = 18 }: { id: string; size?: number }) {
  const meta = metaFor(id);
  const Icon = meta.icon;
  return <span className="componentIcon" style={{ "--c": meta.color } as CSSProperties} aria-hidden="true">{meta.agent ? <AgentIcon runtime={meta.agent} size={size}/> : <Icon size={size}/>}</span>;
}

export function formatBytes(bytes: number, language?: string) {
  const gb = bytes >= 1024 ** 3;
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / 1024 ** (gb ? 3 : 2)) + (gb ? " GB" : " MB");
}

/** Live progress of the install or update running for this component, if any. */
export function ComponentProgress({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const active = useComponentJobs(state => state.active === id);
  const mode = useComponentJobs(state => state.mode);
  const live = useComponentJobs(state => state.progress);
  if (!active) return null;
  return <div className="componentProgress" role="status" aria-live="polite">
    <div><span>{live?.title || t(mode === "install" ? "components.install.preparing" : "components.update.preparing")}</span><b>{live?.percent != null ? `${Math.round(live.percent)}%` : ""}</b></div>
    <div className={clsx("componentProgressTrack", live?.percent == null && "isIndeterminate")}><span style={{ width: `${Math.max(0, Math.min(100, live?.percent ?? 0))}%` }}/></div>
    {live?.downloaded != null && live.total != null && <small>{formatBytes(live.downloaded, i18n.resolvedLanguage)} / {formatBytes(live.total, i18n.resolvedLanguage)}</small>}
  </div>;
}

export function ComponentFailure({ id }: { id: string }) {
  const { t } = useTranslation();
  const failed = useComponentJobs(state => state.failed?.id === id ? state.failed : null);
  const running = useComponentJobs(state => state.active === id);
  if (!failed || running) return null;
  const key = componentErrorKey(failed.error);
  return <div className="componentError isInCard" role="alert"><p>{t(key === "components.update.failed" && failed.mode === "install" ? "components.install.failed" : key)}</p><details><summary>{t("components.details")}</summary><pre>{failed.error}</pre></details></div>;
}

/** One-click install from the catalog bundled with this Aplot build. */
export function ComponentInstallButton({ id, className }: { id: string; className?: string }) {
  const { t, i18n } = useTranslation();
  const catalog = useComponentJobs(state => state.catalog);
  const active = useComponentJobs(state => state.active);
  useEffect(() => { if (!useComponentJobs.getState().catalog) void loadComponentCatalog(); }, []);
  const item = catalog?.components.find(component => component.id === id);
  const missing = catalog !== null && !catalog.installerAvailable;
  const running = active === id;
  return <Button className={clsx("primary componentUpdateButton", className)} disabled={!!active || missing || !item}
    title={missing ? t("components.update.installerMissing") : item?.downloadBytes ? t("components.update.download", { size: formatBytes(item.downloadBytes, i18n.resolvedLanguage) }) : undefined}
    onClick={() => void runComponentJobs([id], "install")}>
    {running ? <RefreshCw size={14} className="componentSpin"/> : <Download size={14}/>}{t(running ? "components.install.running" : "components.install.action")}
  </Button>;
}
