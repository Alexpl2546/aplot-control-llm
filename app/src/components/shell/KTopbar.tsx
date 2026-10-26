import { Copy } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { runColor } from "../../features/launches/presentation";
import { NotificationCenter } from "../feedback/NotificationCenter";

export function KTopbar() {
  const { t } = useTranslation();
  const runs = useControlStore(state => state.runs);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const notify = useControlStore(state => state.notify);
  const index = runs.findIndex(run => run.info.runId === selectedRunId);
  const run = runs[index];
  const copy = async () => {
    if (!run) return;
    try { await navigator.clipboard.writeText(`${run.info.endpoint.replace(/\/$/, "")}/v1`); notify("success", t("k.top.copied")); }
    catch (error) { notify("error", String(error)); }
  };
  return <header className="kTopbar">
    <div className="kTopRun">
      {run && <>
        <span className="kCh" style={{ ["--c" as string]: runColor(run.info.runId) }}>{t("k.serverNumber", { number: index + 1 })}</span>
        <span className={`kLed is-${run.info.state}`} aria-hidden="true"/>
        <b className="kTopName" title={run.info.name}>{run.info.name}</b>
        <span className="kMuted">{ENGINE_NAMES[run.info.engine]} · {t(`status.${run.info.state}`)}</span>
        <button type="button" className="kEndpoint kMono" title={t("k.top.copyEndpoint")} onClick={() => void copy()}>{run.info.endpoint.replace(/^https?:\/\//, "")}/v1<Copy size={12}/></button>
      </>}
    </div>
    <NotificationCenter/>
    {!isTauri() && <span className="kDemo" title={t("k.demo.title")}>{t("k.demo")}</span>}
  </header>;
}
