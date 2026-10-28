import { stopRunWithUndo } from "../../features/launches/stopWithUndo";
import { modelSelectDescription, profileSelectOption } from '../ui/selectOptions';
import { ExternalLink, Layers3, Play, RotateCw, Settings2, Square, MessageSquare } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { duration } from "../../lib/format";
import { ENGINE_NAMES } from "../../lib/engineModels";
import { serverContextSize, strataModelForConfig } from "../../lib/serverContext";
import { sameFilePath } from "../../lib/filePaths";
import { launchBlocker } from "../../features/launches/readiness";
import { isSupportedProfileEngine, profileRunId } from "../../features/launches/profiles";
import { useControlStore } from "../../store/control";
import type { ServerEngine } from "../../types/app";
import { Badge, Button, Panel } from "../ui/Primitives";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { RestartDialog } from "../config/RestartDialog";
import { useLaunchAction } from "../../features/launches/useLaunchAction";
import { RunSelector } from "../../features/launches/RunSelector";

export function ServerHeader() {
  const { t, i18n } = useTranslation();
  const {
    runtime, config, profiles, libraryModels, settings, runningEngine, runningConfig, availableEngines,
    selectedRunId, runs, runBusyById, stopManagedRun,
    selectProfile, selectLibraryModel, updateSettings, setView,
    notify, strataModels, rescanModels, detectBinary,
  } = useControlStore();
  const { requestLaunch, pendingLaunch, confirming, confirmLaunch, cancelLaunch } = useLaunchAction();
  const [choosing, setChoosing] = useState(false);
  const selectedRun = runs.find(run => run.info.runId === selectedRunId);
  const running = Boolean(selectedRun && !["stopped", "crashed"].includes(selectedRun.info.state));
  const controlsBusy = choosing || Boolean(runBusyById[selectedRunId ?? profileRunId(config.profileId)]) || Boolean(selectedRun && !["stopped", "crashed", "ready", "busy"].includes(selectedRun.info.state));
  const actualEngine = (running ? runningEngine : undefined) ?? settings.serverEngine;
  const contextSize = serverContextSize({ runtime: selectedRun ? runtime : { ...runtime, state: "stopped" }, config, settings, strataModels, runningEngine, runningConfig });
  const runtimeModelName = running && ["ready", "busy", "stopping"].includes(runtime.state) ? runtime.modelName : undefined;
  const strataModelName = running
    ? runningConfig?.modelAlias || strataModelForConfig(strataModels, settings.strataConfigPath)?.modelName
    : strataModelForConfig(strataModels, settings.strataConfigPath)?.modelName || (config.engine === "strata" ? config.engineModel || config.modelAlias || config.profileName : undefined);
  const pendingEngine = running && actualEngine !== settings.serverEngine;
  const llamaProfiles = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  const selectedProfile = llamaProfiles.find(profile => profile.id === config.profileId);
  const modelName = actualEngine === "strata" ? runtimeModelName || strataModelName : runtimeModelName || selectedProfile?.name || config.modelAlias;
  const blocker = settings.serverEngine && availableEngines.includes(settings.serverEngine) ? launchBlocker(config, settings) : "engines.none";

  const chooseEngine = async (engine: ServerEngine) => {
    if (engine === settings.serverEngine) return;
    setChoosing(true);
    try {
      const matching = profiles.find(profile => isSupportedProfileEngine(profile.config.engine ?? "llama_cpp") && (profile.config.engine ?? "llama_cpp") === engine);
      if (matching) await selectProfile(matching.id);
      else await updateSettings({ serverEngine: engine });
      if (engine === "llama_cpp") await detectBinary();
      await rescanModels();
    } catch (error) { notify("error", String(error)); }
    finally { setChoosing(false); }
  };
  const chooseModel = async (engine: ServerEngine, pathOrId: string) => {
    const model = engine === "strata"
      ? libraryModels.find(candidate => candidate.id === pathOrId || sameFilePath(candidate.sources.strata?.configPath ?? '', pathOrId))
      : libraryModels.find(candidate => candidate.id === pathOrId || candidate.sources.llama_cpp?.path === pathOrId);
    if (model) {
      try { await selectLibraryModel(model.id, engine); }
      catch (error) { notify("error", String(error)); }
    }
  };
  const launch = (restartExisting: boolean) => requestLaunch(restartExisting && selectedRunId && running ? "restart" : "start", selectedRunId);
  const engineProfiles = profiles.filter(profile => isSupportedProfileEngine(profile.config.engine ?? "llama_cpp") && (profile.config.engine ?? "llama_cpp") === settings.serverEngine);
  const modelOptions = settings.serverEngine === "strata" ? strataModels.map(model => ({ value: model.configPath, label: model.modelName, description: modelSelectDescription(model) }))
    : settings.serverEngine === "llama_cpp" ? libraryModels.filter(model => model.sources.llama_cpp).map(model => ({ value: model.path, label: model.name, description: modelSelectDescription(model) })) : [];
  const profileOptions = engineProfiles.map(profile => ({ ...profileSelectOption(profile), value: `profile:${profile.id}` }));
  const selectionOptions = settings.serverEngine === "llama_cpp" ? profileOptions : [...profileOptions, ...modelOptions.map(model => ({ ...model, value: `model:${model.value}` }))];
  const selectedModel = settings.serverEngine === "strata" ? settings.strataConfigPath : settings.serverEngine === "llama_cpp" ? config.modelPath : "";
  const profileValue = engineProfiles.some(profile => profile.id === config.profileId) ? `profile:${config.profileId}` : `model:${selectedModel}`;
  const chooseSelection = async (value: string) => {
    if (value === profileValue) return;
    setChoosing(true);
    try { if (value.startsWith("profile:")) await selectProfile(value.slice(8)); else if (settings.serverEngine) await chooseModel(settings.serverEngine, value.slice(6)); }
    catch (error) { notify("error", String(error)); }
    finally { setChoosing(false); }
  };

  return <Panel className="serverHero">
    <div className="serverHeroInfo">
      <div className="serverHeroStatus">
        <Badge tone={selectedRun?.info.state === "crashed" ? "red" : running ? "green" : "blue"}>{t(`status.${selectedRun?.info.state ?? 'stopped'}`)}</Badge>
        <span className="subtle">{t("server.uptime")}: {duration(running ? runtime.uptimeSeconds : 0)}</span>
      </div>
      <div className="serverHeroMain">
        <h3>{modelName || t("model.none")}</h3>
        <div className="serverFacts">
          <div><span>{t("metrics.generation")}</span><b className="greenText">{running && runtime.metricsAvailable ? `${runtime.generationTps.toLocaleString(i18n.language, { maximumFractionDigits: 1 })} ${t("k.unit.tps")}` : "—"}</b></div>
          <div><span>{t("metrics.ttft")}</span><b>{running && runtime.ttftMs != null ? `${runtime.ttftMs} ms` : "—"}</b></div>
          <div><span>{t("server.backend")}</span><b>{actualEngine ? ENGINE_NAMES[actualEngine] : t("settings.engine")}</b></div>
          <div><span>{t("settings.apiAddress")}</span><code>{runtime.endpoint}</code></div>
          <div><span>{t("parameters.ctxSize")}</span><b>{contextSize > 0 ? `${Math.round(contextSize / 1024)}K` : "—"}</b></div>
        </div>
        {pendingEngine && <p className="dashboardPendingEngine">{t("dashboard.enginePending", { engine: settings.serverEngine ? ENGINE_NAMES[settings.serverEngine] : t("settings.engine") })}</p>}
      </div>
    </div>
      <div className="serverHeroActions">
        {running && <Button className="danger" disabled={controlsBusy} onClick={() => selectedRunId && void stopRunWithUndo(selectedRunId)}><Square size={14}/>{t("actions.stop")}</Button>}
        <Button disabled={controlsBusy} onClick={() => setView("configuration")}><Settings2 size={14}/>{t("dashboard.editProfile")}</Button>
        {running && <Button onClick={() => setView("apiDocs")}><ExternalLink size={14}/>{t("actions.openApi")}</Button>}
        <Button onClick={() => setView("profiles")}><Layers3 size={14}/>{t("nav.profiles")}</Button>
        {running && <Button disabled={!selectedRunId || !["ready", "busy"].includes(runtime.state)} onClick={() => setView("chat")}><MessageSquare size={14}/>{t("chat.open")}</Button>}
      </div>
    <div className="serverLaunchOptions">
      <div className="serverHeroControls">
        <RunSelector compact disabled={controlsBusy}/>
        <label><span>{t("settings.engine")}</span><ChoiceSelect label={t("settings.engine")} value={settings.serverEngine} disabled={controlsBusy} onChange={value => void chooseEngine(value as ServerEngine)} options={availableEngines.map(engine => ({ value: engine, label: ENGINE_NAMES[engine] }))}/></label>
        <label><span>{t("dashboard.chooseProfile")}</span><ChoiceSelect variant="model" label={t("dashboard.chooseProfile")} value={profileValue} disabled={controlsBusy} onChange={value => void chooseSelection(value)} options={selectionOptions}/></label>
        <Button className="primary serverLaunchButton" disabled={controlsBusy || Boolean(blocker)} aria-describedby={blocker ? 'launch-blocker' : undefined} onClick={() => void launch(running)}>{running ? <RotateCw size={15}/> : <Play size={15}/>} {t(running ? "actions.restart" : "actions.start")}</Button>
      </div>
    </div>
    {blocker && <div className="serverHeroNotice" role="status" id="launch-blocker"><p>{t(blocker)}</p><Button onClick={() => setView(blocker === 'launches.blocked.strataRoot' || blocker === 'launches.blocked.binary' ? "settings" : "models")}>{t(blocker === 'launches.blocked.strataRoot' || blocker === 'launches.blocked.binary' ? "nav.settings" : "nav.library")}</Button></div>}
    <RestartDialog open={Boolean(pendingLaunch)} running={pendingLaunch?.action === "restart"} profileName={pendingLaunch?.profileName ?? config.profileName} pending={confirming} onClose={cancelLaunch} onConfirm={confirmLaunch}/>
  </Panel>;
}
