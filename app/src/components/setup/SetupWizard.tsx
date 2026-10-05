import { Check, ChevronLeft, ChevronRight, FolderOpen, Search, Server, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatModelSize } from "../../lib/models";
import { mergeModelDirectories } from "../../lib/modelDirectories";
import { listScanRoots, scanDiskModels, scanLlamaServers, onDiskScanProgress, type DiskScanProgress, discoverStrataModels } from "../../services/tauri";
import { chooseModelLocation } from "../../services/modelImport";
import { pickDirectory, pickExecutable } from "../../services/dialog";
import { useControlStore } from "../../store/control";
import type { ModelInfo, ScanRoot, ServerEngine, StrataModelOption } from "../../types/app";
import { Button, Input, Select } from "../ui/Primitives";
import { FriendlyInlineError } from "../feedback/FriendlyInlineError";

const LAST_STEP = 2;
const normalizedPath = (path: string) => path.replace(/\\/g, "/").toLowerCase();
const isArchivedServer = (path: string) => /\/(archive|backups?|target)\//.test(normalizedPath(path));
function serverRank(path: string, configured: string) {
  if (configured && normalizedPath(path) === normalizedPath(configured)) return 1000;
  const normalized = normalizedPath(path);
  if (isArchivedServer(path)) return -100;
  if (normalized.includes("/engines/llama.cpp/") && !normalized.includes("/prismml/")) return 200;
  if (normalized.includes("/engines/llama.cpp/")) return 100;
  return 0;
}


export function SetupWizard() {
  const { t } = useTranslation();
  const { settings, updateSettings, detectBinary, rescanModels, busy, initialized } = useControlStore();
  const [step, setStep] = useState(0);
  const [engine, setEngine] = useState<ServerEngine>(settings.serverEngine);
  const [strataRoot, setStrataRoot] = useState(settings.strataRootPath);
  const [strataConfig, setStrataConfig] = useState(settings.strataConfigPath);
  const [strataOptions, setStrataOptions] = useState<StrataModelOption[]>([]);
  useEffect(() => {
    if (engine !== "strata" || !strataRoot) { setStrataOptions([]); return; }
    let active = true;
    void discoverStrataModels(strataRoot).then(options => { if (active) setStrataOptions(options); }).catch(error => { if (active) { setStrataOptions([]); setScanError(String(error)); } });
    return () => { active = false; };
  }, [engine, strataRoot]);
  const [binary, setBinary] = useState(settings.binaryPath);
  const [modelDirectories, setModelDirectories] = useState(settings.modelDirectories);
  const [roots, setRoots] = useState<ScanRoot[]>([]);
  const [selectedRoots, setSelectedRoots] = useState<string[]>([]);
  const [binaryCandidates, setBinaryCandidates] = useState<string[]>([]);
  const [modelCandidates, setModelCandidates] = useState<ModelInfo[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [scanMessage, setScanMessage] = useState("");
  const [scanError, setScanError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<DiskScanProgress>();
  const [elapsed, setElapsed] = useState(0);
  const [scanDrive, setScanDrive] = useState(0);
  const [showOtherServers, setShowOtherServers] = useState(false);
  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    let active = true;
    let dispose: (() => void) | undefined;
    void onDiskScanProgress(value => { if (active) setProgress(value); }).then(unlisten => { if (active) dispose = unlisten; else unlisten(); }).catch(error => { if (active) setScanError(String(error)); });
    return () => { active = false; window.clearInterval(timer); dispose?.(); };
  }, [scanning]);
  const rankedServers = useMemo(() => [...binaryCandidates].sort((a, b) => serverRank(b, settings.binaryPath) - serverRank(a, settings.binaryPath) || a.localeCompare(b)), [binaryCandidates, settings.binaryPath]);
  const recommendedServer = rankedServers.find(path => serverRank(path, settings.binaryPath) > 0);
  const primaryServers = rankedServers.filter(path => path === recommendedServer || !isArchivedServer(path));
  const visibleServers = showOtherServers ? rankedServers : primaryServers.length ? primaryServers : rankedServers;


  useEffect(() => {
    let active = true;
    void listScanRoots().then(found => {
      if (active) setRoots(found);
    }).catch(error => {
      if (active) setScanError(String(error));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setBinary(settings.binaryPath);
    setModelDirectories(settings.modelDirectories);
  }, [settings.binaryPath, settings.modelDirectories]);

  useEffect(() => {
    setEngine(settings.serverEngine);
    setStrataRoot(settings.strataRootPath);
    setStrataConfig(settings.strataConfigPath);
  }, [settings.serverEngine, settings.strataRootPath, settings.strataConfigPath]);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of modelCandidates) {
      const slash = Math.max(model.path.lastIndexOf("\\"), model.path.lastIndexOf("/"));
      const directory = slash > 0 ? model.path.slice(0, slash) : model.path;
      groups.set(directory, [...(groups.get(directory) ?? []), model]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [modelCandidates]);

  if (!initialized || settings.setupCompleted) return null;

  const toggleRoot = (path: string) => setSelectedRoots(current => current.includes(path)
    ? current.filter(root => root !== path)
    : [...current, path]);

  const toggleFolderModels = (models: ModelInfo[]) => {
    const ids = models.map(model => model.id);
    const allSelected = ids.every(id => selectedModelIds.includes(id));
    setSelectedModelIds(current => allSelected
      ? current.filter(id => !ids.includes(id))
      : [...current, ...ids.filter(id => !current.includes(id))]);
  };

  const scanForBinaries = async () => {
    if (!selectedRoots.length) {
      setScanError(t("setup.selectDriveFirst"));
      return;
    }
    setScanError("");
    setScanning(true);
    setElapsed(0);
    setProgress(undefined);
    setScanDrive(0);
    setBinaryCandidates([]);
    try {
      const found: string[] = [];
      for (const [index, root] of [...selectedRoots].entries()) {
        setScanDrive(index + 1);
        setProgress(undefined);
        setScanMessage(t("setup.scanningDrive", { drive: root }));
        found.push(...await scanLlamaServers(root));
      }
      const unique = [...new Set(found)].sort((a, b) => serverRank(b, settings.binaryPath) - serverRank(a, settings.binaryPath) || a.localeCompare(b));
      setBinaryCandidates(unique);
      setScanMessage(t(unique.length ? "setup.scanBinaryFound" : "setup.scanBinaryEmpty", { count: unique.length }));
      if (!binary.trim()) { const suggested = unique.find(path => serverRank(path, settings.binaryPath) > 0); if (suggested) setBinary(suggested); }
    } catch (error) {
      setScanMessage("");
      setScanError(String(error));
    } finally {
      setScanning(false);
    }
  };

  const scanForModels = async () => {
    if (!selectedRoots.length) {
      setScanError(t("setup.selectDriveFirst"));
      return;
    }
    setScanError("");
    setScanning(true);
    setElapsed(0);
    setProgress(undefined);
    setScanDrive(0);
    setModelCandidates([]);
    setSelectedModelIds([]);
    try {
      const found = new Map<string, ModelInfo>();
      for (const [index, root] of [...selectedRoots].entries()) {
        setScanDrive(index + 1);
        setProgress(undefined);
        setScanMessage(t("setup.scanningDrive", { drive: root }));
        for (const model of await scanDiskModels(root)) found.set(model.id, model);
      }
      const models = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
      setModelCandidates(models);
      setScanMessage(t(models.length ? "setup.scanModelsFound" : "setup.scanModelsEmpty", { count: models.length }));
    } catch (error) {
      setScanMessage("");
      setScanError(String(error));
    } finally {
      setScanning(false);
    }
  };

  const continueFromBinary = async () => {
    if (engine === "qwfnfer") { await updateSettings({ serverEngine: engine, setupCompleted: true }); useControlStore.getState().setView("settings"); return; }
    if (engine === "ollama") { await updateSettings({ serverEngine: engine, setupCompleted: true }); useControlStore.getState().setView("settings"); return; }
    if (engine === "strata") {
      if (!strataRoot.trim() || !strataOptions.some(option => option.configPath === strataConfig)) { setScanError(t("error.strataConfigRequired")); return; }
      await updateSettings({ serverEngine: engine, strataRootPath: strataRoot.trim(), strataConfigPath: strataConfig });
      setScanError(""); setStep(1); return;
    }
    if (!binary.trim()) {
      setStep(1);
      return;
    }
    setScanError("");
    await updateSettings({ serverEngine: engine, binaryPath: binary.trim() });
    await detectBinary(binary.trim());
    const error = useControlStore.getState().error;
    if (error) { setScanError(error); return; }
    setStep(1);
  };

  const saveModelDirectories = async () => {
    const selectedDirectories = modelCandidates
      .filter(model => selectedModelIds.includes(model.id))
      .map(model => {
        const slash = Math.max(model.path.lastIndexOf("\\"), model.path.lastIndexOf("/"));
        return slash > 0 ? model.path.slice(0, slash) : model.path;
      });
    let nextDirectories = [...modelDirectories];
    for (const directory of [...new Set(selectedDirectories)]) {
      if (nextDirectories.some(path => normalizedPath(path) === normalizedPath(directory))) continue;
      const added = await chooseModelLocation(directory);
      if (!added) return;
      nextDirectories = mergeModelDirectories(nextDirectories, added);
    }
    setModelDirectories(nextDirectories);
    await updateSettings({ modelDirectories: nextDirectories });
    await rescanModels();
    setStep(LAST_STEP);
  };

  const finish = async () => {
    await updateSettings({ setupCompleted: true, serverEngine: engine, binaryPath: binary.trim(), modelDirectories });
  };

  const addFolder = async () => {
    const path = await pickDirectory();
    if (path) { const added = await chooseModelLocation(path); if (added) setModelDirectories(current => mergeModelDirectories(current, added)); }
  };

  const scanStatus = scanning && <section className="setupScanStatus" role="status" aria-live="polite">
    <div><Search className="setupScanSpinner" size={18}/><b>{scanMessage}</b><span>{t("setup.scanElapsed", { seconds: elapsed })}</span></div>
    <progress aria-label={t("setup.scanInProgress")}/>
    <p>{t("setup.scanCounters", { drive: scanDrive, total: selectedRoots.length, visited: progress?.visited ?? 0, found: progress?.found ?? 0 })}</p>
    {progress?.path && <code title={progress.path}>{progress.path}</code>}
  </section>;

  const scanRootSelection = <ScanRootSelection
    disabled={scanning}
    roots={roots}
    selected={selectedRoots}
    onToggle={toggleRoot}
    onSelectAll={() => setSelectedRoots(roots.map(root => root.path))}
    onClear={() => setSelectedRoots([])}
    t={t}
  />;

  return (
    <div className="setupOverlay">
      <section className="setupShell">
        <aside className="setupRail">
          <div className="setupBrand"><div className="brandMark">O</div><div><b>Aplot</b><span>Control LLM</span></div></div>
          {[0, 1, 2].map(index => <div className={`setupStep ${step === index ? "active" : ""} ${step > index ? "done" : ""}`} key={index}>
            <i>{step > index ? <Check size={13}/> : index + 1}</i><span>{index === 0 ? t("settings.engine") : t(`setup.step${index + 1}`)}</span>
          </div>)}
        </aside>
        <main className="setupMain">
          {step === 0 && <SetupPage icon={<Server/>} title={t("setup.binaryTitle")} text={t("setup.binaryText")}>
            <label>{t("settings.engine")}</label>
            <Select value={engine} disabled={scanning || busy} onChange={event => { setEngine(event.target.value as ServerEngine); setScanError(""); setScanMessage(""); }}><option value="llama_cpp">llama.cpp</option><option value="strata">Strata</option><option value="qwfnfer">QwFNfer</option><option value="ollama">Ollama</option></Select>
            {engine === "llama_cpp" ? <>
            <label>{t("settings.binary")}</label>
            <div className="pathControl"><Input value={binary} placeholder={t("setup.binaryPlaceholder")} onChange={event => setBinary(event.target.value)}/><Button onClick={async () => { const path = await pickExecutable(); if (path) setBinary(path); }}>{t("actions.browse")}</Button></div>
            <p className="setupHint">{t("setup.binaryHint")}</p>
            <h3 className="setupScanHeading">{t("setup.scanBinaryHeading")}</h3>
            <p className="setupHint">{t("setup.scanDriveHelp")}</p>
            {scanRootSelection}
            <Button disabled={scanning || busy} onClick={() => void scanForBinaries()}><Search size={14}/>{t("setup.scanForServer")}</Button>
            {scanStatus}
            {binaryCandidates.length > 0 && <div className="setupServerResults"><p className="setupServerHelp">{t("setup.chooseServerHelp")}</p><fieldset className="setupResults">
              <legend>{t("setup.serverResults", { count: binaryCandidates.length })}</legend>
              {visibleServers.map(path => <label className={`setupResultChoice${binary === path ? " selected" : ""}`} key={path}>
                <input type="radio" name="setup-server-binary" checked={normalizedPath(binary) === normalizedPath(path)} onChange={() => setBinary(path)}/>
                <div><strong>{path === recommendedServer ? t("setup.recommendedServer") : isArchivedServer(path) ? t("setup.archivedServer") : t("setup.otherServer")}</strong><code>{path}</code>{path === recommendedServer && <small>{t("setup.recommendedHelp")}</small>}</div>
              </label>)}
            </fieldset>{rankedServers.some(isArchivedServer) && <Button onClick={() => setShowOtherServers(value => !value)}>{t(showOtherServers ? "setup.hideArchives" : "setup.showArchives")}</Button>}</div>}

            {!scanning && scanMessage && <p className="subtle" role="status">{scanMessage}</p>}
            <p className="setupAdminNote">{t("setup.adminNote")}</p>
            </> : engine === "ollama" ? <p>{t("settings.ollamaHelp")}</p> : <>
              <label>{t("settings.strataFolder")}</label>
              <div className="pathControl"><Input value={strataRoot} onChange={event => setStrataRoot(event.target.value)}/><Button onClick={async () => { const path = await pickDirectory(); if (path) setStrataRoot(path); }}>{t("actions.browse")}</Button></div>
              <label>{t("settings.strataConfig")}</label>
              <Select value={strataConfig} onChange={event => setStrataConfig(event.target.value)}><option value="">{t("dashboard.chooseStrataModel")}</option>{strataOptions.map(option => <option key={option.configPath} value={option.configPath}>{option.modelName}</option>)}</Select>
            </>}
            {scanError && <FriendlyInlineError error={scanError}/>}
          </SetupPage>}
          {step === 1 && <SetupPage icon={<FolderOpen/>} title={t("setup.modelsTitle")} text={t("setup.modelsText")}>
            <h3 className="setupScanHeading">{t("setup.scanModelsHeading")}</h3>
            <p className="setupHint">{t("setup.scanDriveHelp")}</p>
            {scanRootSelection}
            <Button disabled={scanning || busy} onClick={() => void scanForModels()}><Search size={14}/>{t("setup.scanForModels")}</Button>
            {scanStatus}

            {!scanning && scanMessage && <p className="subtle" role="status">{scanMessage}</p>}
            {modelGroups.length > 0 && <div className="setupModelResults">
              <h3>{t("setup.modelResults", { count: modelCandidates.length })}</h3>
              {modelGroups.map(([directory, models]) => {
                const allSelected = models.every(model => selectedModelIds.includes(model.id));
                const someSelected = models.some(model => selectedModelIds.includes(model.id));
                return <section className="setupModelFolder" key={directory}>
                  <label className="setupFolderChoice"><input type="checkbox" checked={allSelected} ref={element => { if (element) element.indeterminate = someSelected && !allSelected; }} onChange={() => toggleFolderModels(models)}/><code>{directory}</code><span>{t("setup.modelCount", { count: models.length })}</span></label>
                  <ul>{models.map(model => <li key={model.id}><span>{model.fileName}</span><small>{formatModelSize(model.sizeBytes)}{model.quantization ? ` · ${model.quantization}` : ""}</small></li>)}</ul>
                </section>;
              })}
            </div>}
            <div className="setupFolderHeader"><label>{t("settings.modelDirs")}</label><Button onClick={() => void addFolder()}><FolderOpen size={14}/>{t("settings.addFolder")}</Button></div>
            {modelDirectories.length === 0 ? <p className="setupHint">{t("setup.noFoldersYet")}</p> : <ul className="setupFolderList">{modelDirectories.map(path => <li key={path}><code>{path}</code><button aria-label={t("actions.remove")} onClick={() => setModelDirectories(current => current.filter(item => item !== path))}><X size={14}/></button></li>)}</ul>}
            <p className="setupAdminNote">{t("setup.adminNote")}</p>
            {scanError && <FriendlyInlineError error={scanError}/>}
          </SetupPage>}
          {step === LAST_STEP && <SetupPage icon={<Check/>} title={t("setup.readyTitle")} text={t("setup.readyText")}>
            <div className="setupSummary"><div><span>llama.cpp</span><b>{binary || t("setup.notConfigured")}</b></div><div><span>{t("settings.modelDirs")}</span><b>{t("setup.folderCount", { count: modelDirectories.length })}</b></div></div>
          </SetupPage>}
          <footer className="setupActions"><span className="setupStepCounter">{step + 1} / {LAST_STEP + 1}</span>
            <Button disabled={step === 0 || busy || scanning} onClick={() => setStep(value => Math.max(0, value - 1))}><ChevronLeft size={14}/>{t("actions.back")}</Button>
            {step === 0 && <Button className="primary" disabled={busy || scanning} onClick={() => void continueFromBinary()}>{t("actions.continue")}<ChevronRight size={14}/></Button>}
            {step === 1 && <Button className="primary" disabled={busy || scanning} onClick={() => void saveModelDirectories()}>{t("actions.continue")}<ChevronRight size={14}/></Button>}
            {step === LAST_STEP && <Button className="primary" disabled={busy} onClick={() => void finish()}><Check size={14}/>{t("setup.finish")}</Button>}
          </footer>
        </main>
      </section>
    </div>
  );
}

function ScanRootSelection({ roots, selected, onToggle, onSelectAll, onClear, t, disabled }: {
  disabled: boolean;
  roots: ScanRoot[];
  selected: string[];
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  t: (key: string) => string;
}) {
  return <section className="scanRootSelection" aria-label={t("setup.availableDrives")}>
    <header><b>{t("setup.availableDrives")}</b><div><button type="button" disabled={disabled} onClick={onSelectAll}>{t("setup.selectAllDrives")}</button><button type="button" disabled={disabled} onClick={onClear}>{t("setup.clearDrives")}</button></div></header>
    {roots.length ? <div>{roots.map(root => <label key={root.path}><input type="checkbox" disabled={disabled} checked={selected.includes(root.path)} onChange={() => onToggle(root.path)}/><b>{root.label}</b></label>)}</div> : <p>{t("setup.noDrives")}</p>}
  </section>;
}

function SetupPage({ icon, title, text, children }: { icon: React.ReactNode; title: string; text: string; children: React.ReactNode }) {
  return <div className="setupPage"><div className="setupHeroIcon">{icon}</div><h1>{title}</h1><p>{text}</p><div className="setupFields">{children}</div></div>;
}
