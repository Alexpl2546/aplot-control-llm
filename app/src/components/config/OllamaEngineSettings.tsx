import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { ollamaStatus, startOllama, stopOllama, type OllamaStatus } from "../../services/ollama";
import { pickExecutable } from "../../services/dialog";
import { Button, Input, Panel } from "../ui/Primitives";
import { SettingRow } from "./SettingRow";

export function OllamaEngineSettings() {
  const { t } = useTranslation();
  const { settings, updateSettings, busy, rescanModels, notify } = useControlStore();
  const [endpoint, setEndpoint] = useState(settings.ollamaEndpoint);
  const [binary, setBinary] = useState(settings.ollamaBinaryPath);
  const [status, setStatus] = useState<OllamaStatus>();
  useEffect(() => { setEndpoint(settings.ollamaEndpoint); setBinary(settings.ollamaBinaryPath); }, [settings.ollamaEndpoint, settings.ollamaBinaryPath]);
  const operate = async (action: "refresh" | "start" | "stop") => {
    if (busy) return;
    useControlStore.setState({ busy: true });
    try {
      const url = new URL(endpoint.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error(t("settings.ollamaEndpoint"));
      await updateSettings({ ollamaEndpoint: url.origin, ollamaBinaryPath: binary.trim() });
      if (action === "start") await startOllama(url.origin, binary.trim());
      if (action === "stop") { await stopOllama(); setStatus(undefined); }
      else setStatus(await ollamaStatus(url.origin));
      await rescanModels();
    } catch (error) { setStatus(undefined); notify("error", String(error)); }
    finally { useControlStore.setState({ busy: false }); }
  };
  return <Panel className="settingsSection">
    <h3>{t("settings.ollamaConnection")}</h3><p className="subtle">{t("settings.ollamaHelp")}</p>
    <SettingRow label={t("settings.ollamaEndpoint")}><Input aria-label={t("settings.ollamaEndpoint")} disabled={busy} value={endpoint} onChange={event => setEndpoint(event.target.value)}/></SettingRow>
    <SettingRow label={t("settings.ollamaBinary")}><div className="pathControl"><Input aria-label={t("settings.ollamaBinary")} disabled={busy} value={binary} onChange={event => setBinary(event.target.value)}/><Button disabled={busy} onClick={async () => { const path = await pickExecutable(); if (path) setBinary(path); }}>{t("actions.browse")}</Button></div></SettingRow>
    <div className="toolbar"><Button disabled={busy} onClick={() => void operate("start")}>{t("settings.ollamaStart")}</Button><Button disabled={busy} onClick={() => void operate("refresh")}>{t("settings.ollamaRefresh")}</Button><Button disabled={busy || !status?.managed} onClick={() => void operate("stop")}>{t("settings.ollamaStop")}</Button></div>
    {status && <p role="status">{t("settings.ollamaConnected", { version: status.version, count: status.models.length })}</p>}
  </Panel>;
}
