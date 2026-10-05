import { ExternalLink, Layers3, Play, RotateCw, Settings2, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { duration } from "../../lib/format";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { serverContextSize } from "../../lib/serverContext";
import { openExternalUrl } from "../../services/desktop";
import { useControlStore } from "../../store/control";
import type { ServerEngine } from "../../types/app";
import { Badge, Button, Panel, Select } from "../ui/Primitives";
import { RestartDialog } from "../config/RestartDialog";

export function ServerHeader() {
  const { t } = useTranslation();
  const { runtime, config, profiles, libraryModels, settings, runningEngine, runningConfig, dirty, busy, start, stop, restart, selectProfile, saveCurrentProfile, updateSettings, setView, notify, strataModels, ollamaModels, rescanModels, detectBinary } = useControlStore();
  const [confirmRestart, setConfirmRestart] = useState(false);
  const running = !["stopped", "crashed"].includes(runtime.state);
  const controlsBusy = busy || runtime.state === "stopping";
  const actualEngine = (running ? runningEngine : undefined) ?? settings.serverEngine;
  const contextSize = serverContextSize({ runtime, config, settings, strataModels, runningEngine, runningConfig });
  const runtimeModelName = ["ready", "busy", "stopping"].includes(runtime.state) ? runtime.modelName : undefined;
  const strataModelName = running ? runningConfig?.modelAlias || strataModels.find(model => model.configPath === settings.strataConfigPath)?.modelName : strataModels.find(model => model.configPath === settings.strataConfigPath)?.modelName;
  const pendingEngine = running && actualEngine !== settings.serverEngine;
  const llamaProfiles = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  const selectedProfile = llamaProfiles.find(profile => profile.id === config.profileId);
  const modelName = actualEngine === "qwfnfer" ? runtimeModelName || settings.qwfn.modelPath.split(/[\\/]/).pop() : actualEngine === "ollama" ? runtimeModelName || settings.ollamaModel : actualEngine === "strata" ? runtimeModelName || strataModelName : runtimeModelName || selectedProfile?.name || config.modelAlias;
  const profileArgument = settings.serverEngine === "llama_cpp" ? selectedProfile?.id : undefined;
  const missingModel = settings.serverEngine === "qwfnfer" ? !settings.qwfn.binaryPath || !settings.qwfn.modelPath : settings.serverEngine === "ollama" ? !ollamaModels.some(model => model.name === settings.ollamaModel && model.capabilities?.includes("completion")) : settings.serverEngine === "strata" ? !strataModels.some(model => model.configPath === settings.strataConfigPath) : !settings.binaryPath || !config.modelPath || (config.engine && config.engine !== "llama_cpp");
  const chooseEngine = async (engine: ServerEngine) => {
    try { await updateSettings({ serverEngine: engine }); if (engine === "llama_cpp") { const profile = llamaProfiles[0]; if (config.engine === "ollama" && profile) await selectProfile(profile.id); await detectBinary(); } await rescanModels(); }
    catch (error) { notify("error", String(error)); }
  };
  const launch = async (restartExisting: boolean) => {
    if (dirty && settings.serverEngine === "llama_cpp") { setConfirmRestart(true); return; }
    if (restartExisting) await restart(profileArgument); else await start(profileArgument);
  };
  return <Panel className="serverHero">
    <div className="serverHeroInfo"><div className="serverHeroStatus"><Badge tone={runtime.state === "crashed" ? "red" : running ? "green" : "blue"}>{t(`status.${runtime.state}`)}</Badge><span className="subtle">{t("server.uptime")}: {actualEngine === "ollama" ? "—" : duration(runtime.uptimeSeconds)}</span></div>
      <div className="serverHeroMain"><h1>{modelName || t("model.none")}</h1><div className="serverFacts"><div><span>{t("server.backend")}</span><b>{ENGINE_NAMES[actualEngine]}</b></div><div><span>{t("settings.apiAddress")}</span><code>{runtime.endpoint}</code></div><div><span>{t("parameters.ctxSize")}</span><b>{contextSize > 0 ? `${Math.round(contextSize / 1024)}K` : "—"}</b></div></div>{pendingEngine && <p className="dashboardPendingEngine">{t("dashboard.enginePending", { engine: ENGINE_NAMES[settings.serverEngine] })}</p>}</div>
    </div>
    <div className="serverHeroControls">
      <label><span>{t("settings.engine")}</span><Select aria-label={t("settings.engine")} value={settings.serverEngine} disabled={controlsBusy} onChange={event => void chooseEngine(event.target.value as ServerEngine)}>{(["llama_cpp", "strata", "ollama", "qwfnfer"] as const).map(engine => <option key={engine} value={engine}>{ENGINE_NAMES[engine]}</option>)}</Select></label>
      {settings.serverEngine === "ollama" ? <label><span>{t("ollama.chooseModel")}</span><Select aria-label={t("ollama.chooseModel")} value={settings.ollamaModel} disabled={controlsBusy} onChange={event => { const id = useControlStore.getState().libraryModels.find(model => model.sources.ollama?.name === event.target.value)?.id; if (id) void useControlStore.getState().selectLibraryModel(id, "ollama").catch(error => notify("error", String(error))); }}><option value="">{t("ollama.chooseModel")}</option>{ollamaModels.filter(model => model.capabilities?.includes("completion")).map(model => <option key={model.name} value={model.name}>{model.name}</option>)}</Select></label>
        : settings.serverEngine === "qwfnfer" ? <label><span>Qwen3.8 Flash Next</span><Select aria-label={t("qwfn.chooseModel")} value={settings.qwfn.modelPath} disabled={controlsBusy} onChange={event => void updateSettings({ qwfn: { ...settings.qwfn, modelPath: event.target.value } }).catch(error => notify("error", String(error)))}><option value="">{t("qwfn.chooseModel")}</option>{libraryModels.filter(model => model.sources.qwfnfer).map(model => <option key={model.path} value={model.path}>{model.name} · {model.quantization || model.path.split(/[\\/]/).pop()}</option>)}</Select></label> : settings.serverEngine === "strata" ? <label><span>{t("profiles.strataSection")}</span><Select aria-label={t("profiles.strataSection")} value={settings.strataConfigPath} disabled={controlsBusy} onChange={event => void updateSettings({ strataConfigPath: event.target.value }).catch(error => notify("error", String(error)))}><option value="">{t("dashboard.chooseStrataModel")}</option>{strataModels.map(model => <option key={model.configPath} value={model.configPath}>{model.modelName}</option>)}</Select></label>
        : <label><span>{t("nav.profiles")}</span><Select aria-label={t("nav.profiles")} value={selectedProfile?.id ?? ""} disabled={controlsBusy} onChange={event => void selectProfile(event.target.value).catch(error => notify("error", String(error)))}><option value="">{t("dashboard.chooseProfile")}</option>{llamaProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</Select></label>}
      <div className="serverHeroActions">{running ? <Button className="danger" disabled={controlsBusy} onClick={() => void stop()}><Square size={14}/>{t("actions.stop")}</Button> : <Button className="primary" disabled={controlsBusy || Boolean(missingModel)} onClick={() => void launch(false)}><Play size={14}/>{t("actions.start")}</Button>}{running && <Button disabled={controlsBusy || Boolean(missingModel)} onClick={() => void launch(true)}><RotateCw size={14}/>{t(pendingEngine ? "dashboard.applyEngine" : "actions.restart")}</Button>}<Button disabled={controlsBusy} onClick={() => setView("configuration")}><Settings2 size={14}/>{t("dashboard.editProfile")}</Button>{running && <Button onClick={() => setView("apiDocs")}><ExternalLink size={14}/>{t("actions.openApi")}</Button>}<Button onClick={() => setView("profiles")}><Layers3 size={14}/>{t("nav.profiles")}</Button>{running && actualEngine === "llama_cpp" && runningConfig?.webUi && <Button onClick={() => void openExternalUrl(runtime.endpoint)}><ExternalLink size={14}/>{t("actions.openWeb")}</Button>}{running && actualEngine === "llama_cpp" && !runningConfig?.webUi && <Button onClick={() => setView("configuration")}><Settings2 size={14}/>{t("dashboard.configureWebUi")}</Button>}</div>
    </div>
    {missingModel && <div className="serverHeroNotice" role="alert"><p>{t("models.chooseCompatibleEngine")}</p><Button onClick={() => setView("models")}>{t("nav.library")}</Button></div>}
    <RestartDialog open={confirmRestart} running={running} profileName={config.profileName} onClose={() => setConfirmRestart(false)} onConfirm={async () => { try { await saveCurrentProfile(); if (running) await restart(profileArgument); else await start(profileArgument); } catch (error) { notify("error", String(error)); } }}/>
  </Panel>;
}
