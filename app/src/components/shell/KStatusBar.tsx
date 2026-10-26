import { Plug } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { version as appVersion } from "../../../package.json";

export function KStatusBar() {
  const { t } = useTranslation();
  const runs = useControlStore(state => state.runs);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const settings = useControlStore(state => state.settings);
  const run = runs.find(item => item.info.runId === selectedRunId);
  return <div className="kStatus" aria-label={t("k.status.label")}>
    {run && <span><Plug size={12}/><b className="kMono">{run.info.endpoint.replace(/\/$/, "")}/v1</b></span>}
    <span className="kPush">{!isTauri() && <b className="kDemoText">● {t("k.demo")}</b>}</span>
    <span>{settings.language.toUpperCase()}</span>
    <span className="kMono">v{appVersion}</span>
  </div>;
}
