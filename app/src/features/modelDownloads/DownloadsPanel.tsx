import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, CirclePause, CirclePlay, Download, RotateCcw, Trash2, X } from "lucide-react";
import { Badge, Button, Panel } from "../../components/ui/Primitives";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { useModelDownloadStore } from "./store";
import { useControlStore } from "../../store/control";
import { revealItem } from "../../services/desktop";
import { mergeModelDirectories } from "../../lib/modelDirectories";
import { ENGINE_NAMES, type EngineModel } from "../../lib/engineModels";
import { openSettingsSection } from "../../services/settingsWindow";
import type { DownloadState, DownloadTask } from "./types";
import type { ServerEngine } from "../../types/app";
import { dismissPreparation, forgetAcquisitionEntry, useAcquisitionStore } from './acquisition';
import { PreparationPanel } from './PreparationPanel';
import { modelsForDownload, profileEnginesForModel } from "./profileChoices";

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) { value /= 1024; unit = units[index]; }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
};
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const formatDuration = (seconds: number) => seconds >= 3600
  ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
  : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
const activeStates: DownloadState[] = ["queued", "resolving", "downloading", "verifying", "installing", "pausing", "retry_wait"];
const finishedHistoryStates: DownloadState[] = ["completed", "failed", "cancelled", "interrupted"];
const stateTone = (state: DownloadState) => state === "completed" ? "green" : ["failed", "cancelled"].includes(state) ? "red" : ["paused", "interrupted"].includes(state) ? "orange" : "blue";

export function DownloadsPanel({ onDownload }: { onDownload?: () => void }) {
  const { t } = useTranslation();
  const readyProfiles = useAcquisitionStore(state => state.readyProfiles);
  const preparation = useAcquisitionStore(state => state.preparation);
  const { tasks, loading, initialized, error, demoMode, refresh, pause, resume, cancel, removePartial, removeHistory, clearFinishedHistory } = useModelDownloadStore();
  const { availableEngines, rescanModels, setView, updateSettings, busy, optimizerRunning } = useControlStore();
  const [expanded, setExpanded] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<DownloadTask>();
  const [historyTarget, setHistoryTarget] = useState<DownloadTask>();
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const [profileTarget, setProfileTarget] = useState<DownloadTask>();
  const [profileModels, setProfileModels] = useState<EngineModel[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const profileLookupId = useRef(0);
  const profileModalRef=useRef<HTMLDialogElement>(null);
  const profileDialogRef = useRef<HTMLElement | null>(null);
  const profileFocusReturnRef = useRef<HTMLElement | null>(null);
  const restoreProfileFocusRef = useRef(true);
  const mountedRef = useRef(true);
  const completedIds = useRef(new Set<string>());
  const profileOpen = Boolean(profileTarget);
  const hasClearableHistory = tasks.some(task => finishedHistoryStates.includes(task.state)) || Boolean(preparation && preparation.state !== "installing");
  useEffect(() => { if (!initialized && !loading) void refresh(); }, [initialized, loading, refresh]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      profileLookupId.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!profileOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    profileFocusReturnRef.current = previous;
    profileModalRef.current?.showModal();
    profileDialogRef.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href]")?.focus();
    return () => {
      profileModalRef.current?.close();
      const target = profileFocusReturnRef.current;
      profileFocusReturnRef.current = null;
      if (restoreProfileFocusRef.current && target?.isConnected) target.focus();
      restoreProfileFocusRef.current = true;
    };
  }, [profileOpen]);
  useEffect(() => {
    const newlyCompleted = tasks.filter(task => task.state === "completed" && !completedIds.current.has(task.id));
    if (!newlyCompleted.length) return;
    newlyCompleted.forEach(task => completedIds.current.add(task.id));
    void rescanModels();
  }, [tasks, rescanModels]);

  const requestRemove = async () => {
    if (!removeTarget) return;
    await removePartial(removeTarget.id);
    setRemoveTarget(undefined);
  };
  const requestHistoryRemove = async () => {
    if (!historyTarget) return;
    const removed = await removeHistory(historyTarget.id);
    if (!removed) throw new Error(useModelDownloadStore.getState().error ?? t("downloads.removeHistoryTitle"));
    forgetAcquisitionEntry(historyTarget.id);
    setHistoryTarget(undefined);
  };
  const requestClearFinished = async () => {
    const removed = await clearFinishedHistory();
    if (removed === undefined) throw new Error(useModelDownloadStore.getState().error ?? t("downloads.clearFinishedTitle"));
    removed.forEach(forgetAcquisitionEntry);
    if (preparation && preparation.state !== "installing") dismissPreparation(preparation.id);
    setClearHistoryOpen(false);
  };
  const findInLibrary = async (task: DownloadTask) => {
    const root = task.installedPath || task.plan.finalPath;
    if (!root || demoMode) return;
    setActionError("");
    try {
      const settings = useControlStore.getState().settings;
      const modelDirectories = mergeModelDirectories(settings.modelDirectories, root);
      if (modelDirectories.length !== settings.modelDirectories.length) await updateSettings({ modelDirectories });
      await rescanModels();
      setView("models");
    } catch (cause) { setActionError(String(cause)); }
  };
  const openFolder = async (task: DownloadTask) => {
    const root = task.installedPath || task.plan.finalPath;
    if (!root || demoMode) return;
    setActionError("");
    try { await revealItem(root); }
    catch (cause) { setActionError(String(cause)); }
  };
  const closeProfileDialog = () => {
    profileLookupId.current += 1;
    setProfileTarget(undefined);
    setProfileModels([]);
    setProfileError("");
    setProfileLoading(false);
  };
  const openProfileDialog = async (task: DownloadTask) => {
    const lookupId = ++profileLookupId.current;
    setProfileTarget(task);
    setProfileModels([]);
    setProfileError("");
    setProfileLoading(false);
    if (demoMode) return;

    setProfileLoading(true);
    try {
      const root = task.installedPath || task.plan.finalPath;
      const state = useControlStore.getState();
      const modelDirectories = mergeModelDirectories(state.settings.modelDirectories, root);
      if (modelDirectories.length !== state.settings.modelDirectories.length) await state.updateSettings({ modelDirectories });
      if (!mountedRef.current || lookupId !== profileLookupId.current) return;
      await useControlStore.getState().rescanModels();
      if (mountedRef.current && lookupId === profileLookupId.current) {
        setProfileModels(modelsForDownload(task, useControlStore.getState().libraryModels));
      }
    } catch (cause) {
      if (mountedRef.current && lookupId === profileLookupId.current) setProfileError(String(cause));
    } finally {
      if (mountedRef.current && lookupId === profileLookupId.current) setProfileLoading(false);
    }
  };
  const configureDownloadedModel = async (model: EngineModel, engine: ServerEngine) => {
    if (profileActionBusy) return;
    setProfileActionBusy(true);
    setProfileError("");
    try {
      const state = useControlStore.getState();
      if (!await state.selectLibraryModel(model.id, engine)) {
        if (mountedRef.current) setProfileError(useControlStore.getState().error || t("downloads.createProfileNoEngine"));
        return;
      }
      restoreProfileFocusRef.current = false;
      closeProfileDialog();
      useControlStore.getState().setView("configuration");
    } catch (cause) {
      if (mountedRef.current) setProfileError(String(cause));
    } finally {
      if (mountedRef.current) setProfileActionBusy(false);
    }
  };
  const openEngineSettings = () => {
    closeProfileDialog();
    openSettingsSection("engine");
  };

  return <Panel className="downloadsPanel">
    <header className="downloadsPanelHeader">
      <button className="downloadsPanelToggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Download size={17}/><b>{t("downloads.queueTitle")}</b><span className="downloadsCount">{tasks.length + (preparation ? 1 : 0)}</span></button>
      <div className="downloadsPanelActions">{hasClearableHistory && <Button disabled={loading} onClick={() => setClearHistoryOpen(true)}>{t("downloads.clearFinished")}</Button>}<Button disabled={loading} onClick={() => void refresh()}>{t("downloads.refresh")}</Button>{onDownload && <Button className="primary" onClick={onDownload}>{t("downloads.newDownload")}</Button>}</div>
    </header>
    {demoMode && <p className="downloadsDemoNote">{t("downloads.demoMode")}</p>}
    {expanded && <>
      <PreparationPanel/>
      {error && <p className="downloadsError" role="alert">{error}</p>}
      {actionError && <p className="downloadsError" role="alert">{actionError}</p>}
      {loading && !initialized && <p role="status">{t("downloads.loading")}</p>}
      {!loading && initialized && !tasks.length && !preparation && <p className="downloadsEmpty">{t("downloads.empty")}</p>}
      <div className="downloadsList" aria-live="polite">
        {tasks.map(task => {
          const percent = task.totalBytes > 0 ? Math.max(0, Math.min(100, Math.round(task.downloadedBytes / task.totalBytes * 100))) : 0;
          const active = activeStates.includes(task.state);
          const canResume = ["paused", "interrupted", "cancelled", "failed"].includes(task.state);
          const canRemovePartial = ["paused", "interrupted", "failed", "cancelled"].includes(task.state);
          const canPause = active && !["pausing", "installing"].includes(task.state);
          const canCancel = active && task.state !== "installing";
          const etaSeconds = task.state === "downloading" && task.speedBytesPerSecond > 0
            ? Math.ceil(Math.max(0, task.totalBytes - task.downloadedBytes) / task.speedBytesPerSecond) : undefined;
          return <article className={`downloadTask${active ? " isActive" : ""}`} key={task.id}>
            <div className="downloadTaskHead"><div className="downloadTaskIdentity"><b title={task.plan.repoId}>{task.plan.repoId}</b><small title={task.plan.revision}>{task.plan.revision.slice(0, 8)} · {task.plan.files.length} {t("downloads.files")}</small></div><div className="downloadTaskHeadActions"><Badge tone={stateTone(task.state)}>{t(`downloads.state.${task.state}`)}</Badge>{!active && <Button className="downloadDismiss" aria-label={t("downloads.removeHistory")} title={t("downloads.removeHistory")} onClick={() => setHistoryTarget(task)}><X size={14}/></Button>}</div></div>
            <div className="downloadTaskProgress"><progress max={100} value={percent} aria-label={t("downloads.progress", { percent })}/><span>{percent}%</span><small>{formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}</small></div>
            {(task.currentFile || task.speedBytesPerSecond > 0 || etaSeconds !== undefined) && <small className="downloadTaskLiveMeta">{task.currentFile && <span title={task.currentFile}>{fileName(task.currentFile)}</span>}{task.speedBytesPerSecond > 0 && <span>{formatBytes(task.speedBytesPerSecond)}/s</span>}{etaSeconds !== undefined && <span>{t("downloads.eta", { time: formatDuration(etaSeconds) })}</span>}</small>}
            {task.error && <div className="downloadTaskError"><AlertTriangle size={14}/><span>{task.error.message}</span></div>}
            <div className="downloadTaskActions">
              {canPause && <Button aria-label={t("downloads.pause")} onClick={() => void pause(task.id)}><CirclePause size={15}/>{t("downloads.pause")}</Button>}
              {canResume && <Button className="primary" aria-label={task.state === "failed" ? t("downloads.retry") : t("downloads.resume")} onClick={() => void resume(task.id)}>{task.state === "failed" ? <RotateCcw size={15}/> : <CirclePlay size={15}/ >}{task.state === "failed" ? t("downloads.retry") : t("downloads.resume")}</Button>}
              {canCancel && <Button className="downloadCancel" aria-label={t("downloads.cancel")} onClick={() => void cancel(task.id)}><X size={15}/>{t("downloads.cancel")}</Button>}
              {canRemovePartial && <Button className="downloadRemove downloadIconAction" aria-label={t("downloads.removePartial")} title={t("downloads.removePartial")} onClick={() => setRemoveTarget(task)}><Trash2 size={14}/></Button>}
              {task.state === "completed" && <Button className="primary" disabled={busy || optimizerRunning} onClick={() => void openProfileDialog(task)}>{t("models.createProfile")}</Button>}
            </div>
            {task.state === "completed" && <details className="downloadTaskDetails">
              <summary>{t("aw.details")}</summary>
              <div className="downloadTaskMore">
                <div className="downloadTaskDone"><Check size={14}/><span>{t("downloads.completedFiles")}</span>{task.installedPath && <small title={task.installedPath}>{task.installedPath}</small>}</div>
                <p className="downloadTaskStrata">{t(readyProfiles.includes(task.id)?"recipes.profileReady":"downloads.strataNote")}</p>
                <div className="downloadTaskActions">
                <Button disabled={demoMode} onClick={() => void openFolder(task)}>{t("downloads.openFolder")}</Button>
                <Button disabled={demoMode} onClick={() => void findInLibrary(task)}>{t("downloads.findInLibrary")}</Button>
                </div>
              </div>
            </details>}
          </article>;
        })}
      </div>
    </>}
    {removeTarget && createPortal(<ConfirmDialog open title={t("downloads.removeTitle")} text={t("downloads.removeHelp")} confirmLabel={t("downloads.removePartial")} dangerous onCancel={() => setRemoveTarget(undefined)} onConfirm={requestRemove}/>, document.body)}
    {historyTarget && createPortal(<ConfirmDialog open title={t("downloads.removeHistoryTitle")} text={t("downloads.removeHistoryHelp")} confirmLabel={t("downloads.removeHistory")} dangerous onCancel={() => setHistoryTarget(undefined)} onConfirm={requestHistoryRemove}/>, document.body)}
    {clearHistoryOpen && createPortal(<ConfirmDialog open title={t("downloads.clearFinishedTitle")} text={t("downloads.clearFinishedHelp")} confirmLabel={t("downloads.clearFinished")} dangerous onCancel={() => setClearHistoryOpen(false)} onConfirm={requestClearFinished}/>, document.body)}
    {profileTarget && createPortal(<dialog ref={profileModalRef} aria-labelledby="download-profile-title" className="modalBackdrop downloadProfileBackdrop" onCancel={event=>{event.preventDefault();event.stopPropagation();if(!profileActionBusy)closeProfileDialog();}} onMouseDown={event => { if (event.currentTarget === event.target && !profileActionBusy) closeProfileDialog(); }}>
      <section ref={profileDialogRef} className="modalCard downloadProfileDialog" onKeyDown={event => {
        if (event.key === "Escape" && !profileActionBusy) { event.preventDefault(); closeProfileDialog(); }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),a[href]"));
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}>
        <header><div><h2 id="download-profile-title">{t("downloads.createProfileTitle")}</h2><p>{t("downloads.createProfileHelp")}</p></div><Button aria-label={t("actions.close")} disabled={profileActionBusy} onClick={closeProfileDialog}><X size={15}/></Button></header>
        <div className="downloadProfileChoices">
          {profileLoading && <p role="status">{t("downloads.createProfileChecking")}</p>}
          {!profileLoading && demoMode && <p role="status">{t("downloads.createProfileDemoNotice")}</p>}
          {!profileLoading && !demoMode && !profileModels.length && <div>
            <p>{t("downloads.createProfileNoModel")}</p>
            <Button disabled={busy || optimizerRunning} onClick={() => void openProfileDialog(profileTarget)}>{t("downloads.createProfileRescan")}</Button>
          </div>}
          {!profileLoading && profileModels.map(model => {
            const engines = profileEnginesForModel(model, availableEngines);
            return <article className="downloadProfileChoice" key={model.id}>
              <div><b>{model.name}</b><code>{model.path}</code></div>
              {engines.length > 0
                ? <div className="downloadProfileEngines">{engines.map(engine => <Button key={engine} disabled={profileActionBusy || busy || optimizerRunning} onClick={() => void configureDownloadedModel(model, engine)}>{t("downloads.createProfileWithEngine", { engine: ENGINE_NAMES[engine] })}</Button>)}</div>
                : <p role="status">{t("downloads.createProfileNoEngine")}</p>}
              {!model.sources.strata && <div className="downloadProfileStrata" role="note">
                <p>{t("downloads.createProfileStrataNeedsConfig")}</p>
                <Button disabled={profileActionBusy} onClick={openEngineSettings}>{t("downloads.createProfileEngineSettings")}</Button>
              </div>}
            </article>;
          })}
          {profileError && <p className="downloadsError" role="alert">{profileError}</p>}
          {!profileLoading && !demoMode && !profileModels.length && availableEngines.includes("strata") && <div className="downloadProfileStrata" role="note">
            <p>{t("downloads.createProfileStrataNeedsConfig")}</p>
            <Button disabled={profileActionBusy} onClick={openEngineSettings}>{t("downloads.createProfileEngineSettings")}</Button>
          </div>}
        </div>
        <footer><Button disabled={profileActionBusy} onClick={closeProfileDialog}>{t("actions.cancel")}</Button></footer>
      </section>
    </dialog>, document.body)}
  </Panel>;
}
