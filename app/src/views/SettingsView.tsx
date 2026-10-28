import { isTauri } from "../services/tauri";
import { useUiPrefs, type Density } from "../lib/uiPrefs";
import { toggleMiniWindow } from "../features/mini/miniWindow";
import { ConnectionsSettingsContent } from '../features/openai/OpenAiPanel';
import { AgentPresetsSettingsContent } from '../features/agent/AgentPresets';
import { openSettingsSection } from '../services/settingsWindow';
import { Copy, Cpu, Download, Eye, EyeOff, FolderOpen, FolderPlus, Layers, RefreshCw, Server, Shuffle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import type { AppLanguage, AppSettings, StrataModelOption, ThemePreference } from "../types/app";
import { Button, Input, Panel, Select, Switch } from "../components/ui/Primitives";
import { chooseModelLocation } from "../services/modelImport";
import { pickDirectory, pickExecutable } from "../services/dialog";
import { discoverStrataModels } from "../services/tauri";
import { StrataEngines } from "./StrataEngines";
import { StrataRouterState } from "./StrataRouterState";
import { SettingRow as Setting } from "../components/config/SettingRow";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";
import { ComponentManager } from "../components/config/ComponentManager";
import { loadComponentCatalog, loadComponentMaintenance } from "../components/config/componentJobs";
import { ComponentFailure, ComponentIcon, ComponentInstallButton, ComponentProgress } from "../components/config/ComponentInstall";
import "./engineSettings.css";
import { APP_LANGUAGES } from "../lib/languages";

function createRouterApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `aplot_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function SettingsView() {
  const density = useUiPrefs(state => state.density);
  const mica = useUiPrefs(state => state.mica);
  const sidebarPinned = useUiPrefs(state => state.sidebarPinned);
  const { t } = useTranslation();
  const section=useControlStore(state=>state.settingsSection);
  const setSection=openSettingsSection;
  const sectionContent=useRef<HTMLDivElement>(null);
  useEffect(()=>{sectionContent.current?.scrollTo({top:0});},[section]);
  // Component sizes take a while to measure; start as soon as settings open so the tab is ready.
  useEffect(()=>{ if(isTauri()){ void loadComponentMaintenance().catch(()=>undefined); void loadComponentCatalog(); } },[]);
  const installedEngines = useControlStore(state => state.availableEngines);
  const { settings, updateSettings, detectBinary, capabilities, busy, notify, setView } = useControlStore();
  const [binary, setBinary] = useState(settings.binaryPath);
  const [directories, setDirectories] = useState(settings.modelDirectories.join("\n"));
  const [routerHost, setRouterHost] = useState(settings.routerHost);
  const [routerPort, setRouterPort] = useState(String(settings.routerPort));
  const [routerMaxLoaded, setRouterMaxLoaded] = useState(String(settings.routerMaxLoadedModels));
  const [routerApiKey, setRouterApiKey] = useState(settings.routerApiKey);
  const [showRouterApiKey, setShowRouterApiKey] = useState(false);
  const [strataRootPath, setStrataRootPath] = useState(settings.strataRootPath);
  const [strataConfigPath, setStrataConfigPath] = useState(settings.strataConfigPath);
  const [strataHost, setStrataHost] = useState(settings.strataHost);
  const [strataPort, setStrataPort] = useState(String(settings.strataPort));
  const [strataApiKey, setStrataApiKey] = useState(settings.strataApiKey);
  const [strataModels, setStrataModels] = useState<StrataModelOption[]>([]);
  const [strataDiscoveryError, setStrataDiscoveryError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const modelDirectoriesValue = settings.modelDirectories.join("\n");
  const folders = directories.split(/\r?\n/).map(value => value.trim()).filter(Boolean);

  // Refresh only the saved field that changed; other fields can contain unsaved edits.
  useEffect(() => { setBinary(settings.binaryPath); }, [settings.binaryPath]);
  useEffect(() => { setDirectories(modelDirectoriesValue); }, [modelDirectoriesValue]);
  useEffect(() => { setRouterHost(settings.routerHost); }, [settings.routerHost]);
  useEffect(() => { setRouterPort(String(settings.routerPort)); }, [settings.routerPort]);
  useEffect(() => { setRouterMaxLoaded(String(settings.routerMaxLoadedModels)); }, [settings.routerMaxLoadedModels]);
  useEffect(() => { setRouterApiKey(settings.routerApiKey); }, [settings.routerApiKey]);
  useEffect(() => { setStrataRootPath(settings.strataRootPath); }, [settings.strataRootPath]);
  useEffect(() => { setStrataConfigPath(settings.strataConfigPath); }, [settings.strataConfigPath]);
  useEffect(() => { setStrataHost(settings.strataHost); }, [settings.strataHost]);
  useEffect(() => { setStrataPort(String(settings.strataPort)); }, [settings.strataPort]);
  useEffect(() => { setStrataApiKey(settings.strataApiKey); }, [settings.strataApiKey]);

  const [autoError, setAutoError] = useState("");
  const [savedAt, setSavedAt] = useState(0);
  /* Text fields save themselves shortly after typing stops, like every other setting here. */
  const draftKey = JSON.stringify([binary, directories, routerHost, routerPort, routerMaxLoaded, routerApiKey, strataRootPath, strataConfigPath, strataHost, strataPort, strataApiKey]);
  const savedKey = JSON.stringify([settings.binaryPath, settings.modelDirectories.join("\n"), settings.routerHost, String(settings.routerPort), String(settings.routerMaxLoadedModels), settings.routerApiKey, settings.strataRootPath, settings.strataConfigPath, settings.strataHost, String(settings.strataPort), settings.strataApiKey]);
  const pendingSave = useRef<() => void>(() => undefined);
  pendingSave.current = () => { if (draftKey !== savedKey) void savePaths(true); };
  useEffect(() => {
    if (draftKey === savedKey) return;
    const timer = window.setTimeout(() => pendingSave.current(), 900);
    return () => window.clearTimeout(timer);
  }, [draftKey, savedKey]);
  useEffect(() => () => pendingSave.current(), []);

  const applySettings = async (patch: Partial<AppSettings>) => {
    try { await updateSettings(patch); }
    catch (error) { notify("error", String(error)); }
  };

  useEffect(() => {
    if (!settings.strataRootPath) {
      setStrataModels([]);
      return;
    }
    let active = true;
    void discoverStrataModels(settings.strataRootPath)
      .then(models => { if (active) { setStrataModels(models); setStrataDiscoveryError(""); } })
      .catch(error => { if (active) { setStrataModels([]); setStrataDiscoveryError(String(error)); } });
    return () => { active = false; };
  }, [settings.strataRootPath]);

  const findStrataModels = async (root = strataRootPath) => {
    if (!root.trim()) {
      setStrataDiscoveryError(t("settings.strataNoModels"));
      return;
    }
    try {
      const models = await discoverStrataModels(root);
      setStrataModels(models);
      setStrataDiscoveryError("");
      if (!models.some(model => model.configPath === strataConfigPath)) setStrataConfigPath(models[0]?.configPath ?? "");
    } catch (error) {
      setStrataModels([]);
      setStrataDiscoveryError(String(error));
    }
  };

  const savePaths = async (quiet = false) => {
    if (savingRef.current || busy) return;
    const fail = (message: string) => { setAutoError(message); if (!quiet) notify("error", message); };
    const port = Number(routerPort);
    const maximum = Number(routerMaxLoaded);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { fail(t("router.invalidPort")); return; }
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64) { fail(t("router.invalidMaximum")); return; }
    const strataPortNumber = Number(strataPort);
    if (!Number.isInteger(strataPortNumber) || strataPortNumber < 1 || strataPortNumber > 65535) { fail(t("router.invalidPort")); return; }
    if (settings.serverEngine === "strata" && !isLoopback(strataHost) && !strataApiKey.trim()) { fail(t("settings.strataKeyHelp")); return; }
    // While a key field is being retyped it can be empty for a moment: autosave keeps the saved key.
    const effectiveRouterApiKey = routerApiKey.trim() || (quiet ? settings.routerApiKey : "") || createRouterApiKey();
    savingRef.current = true;
    setSaving(true);
    try {
      await updateSettings({
        binaryPath: binary.trim(),
        modelDirectories: directories.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        routerHost: routerHost.trim(),
        routerPort: port,
        routerMaxLoadedModels: maximum,
        routerAutoload: true,
        routerApiKey: effectiveRouterApiKey,
        strataRootPath: strataRootPath.trim(),
        strataConfigPath: strataConfigPath.trim(),
        strataHost: strataHost.trim(),
        strataPort: strataPortNumber,
        strataApiKey: strataApiKey.trim(),
      });
      if (!quiet || routerApiKey.trim()) setRouterApiKey(effectiveRouterApiKey);
      setAutoError(""); setSavedAt(Date.now());
    } catch (error) { fail(String(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const regenerateRouterApiKey = async () => {
    if (savingRef.current || busy) return;
    const nextKey = createRouterApiKey();
    savingRef.current = true;
    setSaving(true);
    try {
      await updateSettings({ routerApiKey: nextKey });
      setRouterApiKey(nextKey);
      notify("success", t("router.apiKeyGenerated"));
    } catch (error) { notify("error", String(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const copyRouterApiKey = async () => {
    try { await navigator.clipboard.writeText(routerApiKey); notify("success", t("router.apiKeyCopied")); }
    catch (error) { notify("error", t("router.apiKeyCopyFailed")); useControlStore.setState({ error: String(error) }); }
  };

  return <div className="page">
    <div className="settingsWindowLayout"><nav className="settingsWindowNav">{(['general','engine','components'] as const).map(value=><button type="button" key={value} aria-pressed={section===value} onClick={()=>setSection(value)}>{t(`settings.window.${value}`)}</button>)}<button type="button" aria-pressed={section==='connections'} onClick={()=>setSection('connections')}>{t('openai.connections')}</button><button type="button" aria-pressed={section==='agents'} onClick={()=>setSection('agents')}>{t('presets.title')}</button></nav><div className={`settingsWindowContent is-${section}`} ref={sectionContent}><section hidden={section!=='connections'} aria-label={t('openai.connections')}><h2>{t('openai.connections')}</h2><ConnectionsSettingsContent/></section><section hidden={section!=='agents'} aria-label={t('presets.title')}><h2>{t('presets.title')}</h2><AgentPresetsSettingsContent/></section>{section==='components'?<ComponentManager/>:(section==='general'||section==='engine')?<div className="settingsGrid">
      <div className="settingsColumn settingsEngineColumn engineSettings">
      <div className="engineChoice" role="radiogroup" aria-label={t("settings.engine")}>
        {(["llama_cpp", "strata"] as const).map(engine => {
          const installed = installedEngines.includes(engine);
          return <button type="button" role="radio" key={engine} aria-checked={settings.serverEngine === engine} className="engineTile" onClick={() => {
            if (settings.serverEngine === engine) return;
            void applySettings({ serverEngine: engine });
            if (engine === "llama_cpp" && binary.trim()) void detectBinary(binary).catch(error => notify("error", String(error)));
          }}>
            <ComponentIcon id={engine} size={20}/>
            <span className="engineTileText"><strong>{engine === "llama_cpp" ? "llama.cpp" : "Strata"}</strong><small>{t(`engine.hint.${engine}`)}</small></span>
            <span className={`componentStatus is-${installed ? "installed" : "absent"}`}><i aria-hidden="true"/>{t(installed ? "components.status.installed" : "components.status.absent")}</span>
            <span className="engineRadio" aria-hidden="true"/>
          </button>;
        })}
      </div>
      {settings.legacyEngineId && <p className="serverHeroNotice" role="status">{t("profiles.unsupportedEngine", { engine: settings.legacyEngineId })}</p>}
      {!settings.serverEngine && <p className="engineEmpty">{t("engine.choose")}</p>}
      {settings.serverEngine && !installedEngines.includes(settings.serverEngine) && <div className="engineInstall">
        <div><span>{t("engine.installFirst", { name: settings.serverEngine === "llama_cpp" ? "llama.cpp" : "Strata" })}</span><ComponentInstallButton id={settings.serverEngine}/></div>
        <ComponentProgress id={settings.serverEngine}/><ComponentFailure id={settings.serverEngine}/>
      </div>}

      {settings.serverEngine === "llama_cpp" && <>
        <Panel className="settingsSection engineBlock">
          <h3><Cpu size={15}/>{t("engine.program")}</h3>
          <Setting label={t("settings.binary")}>
            <div className="pathControl enginePath"><Input value={binary} onChange={event => setBinary(event.target.value)}/>
              <Button onClick={async () => { const path = await pickExecutable(); if (path) setBinary(path); }}>{t("actions.browse")}</Button>
              <Button className="kIconBtn" disabled={busy || !binary.trim()} title={t("settings.detect")} aria-label={t("settings.detect")} onClick={() => void detectBinary(binary)}><RefreshCw size={14}/></Button>
            </div>
            {capabilities.version && <span className="componentTag isVersion engineVersion">{capabilities.version}</span>}
          </Setting>
        </Panel>
        <Panel className="settingsSection engineBlock">
          <h3><FolderOpen size={15}/>{t("settings.modelDirs")}</h3>
          {folders.length ? <ul className="engineFolders">{folders.map(folder => <li key={folder}><code title={folder}>{folder}</code><Button className="kIconBtn" title={t("engine.removeFolder")} aria-label={`${t("engine.removeFolder")}: ${folder}`} onClick={() => setDirectories(folders.filter(value => value !== folder).join("\n"))}><X size={14}/></Button></li>)}</ul>
            : <p className="engineEmpty">{t("engine.noFolders")}</p>}
          <Button onClick={async () => { const path = await pickDirectory(); if (path) { const added = await chooseModelLocation(path); if (added && !folders.includes(added)) setDirectories([...folders, added].join("\n")); } }}><FolderPlus size={14}/>{t("settings.addFolder")}</Button>
        </Panel>
        <Panel className="settingsSection engineBlock routerSettings">
          <h3><Server size={15}/>{t("engine.server")}<span className="engineHeadNote">{t("engine.restartNote")}</span></h3>
          <Setting label={t("router.mode")} help={t(settings.serverMode === "router" ? "engine.modeRouterHint" : "engine.modeSingleHint")}>
            <div className="engineSegmented" role="radiogroup" aria-label={t("router.mode")}>
              {(["router", "single"] as const).map(mode => <button type="button" role="radio" key={mode} aria-checked={settings.serverMode === mode} onClick={() => void applySettings({ serverMode: mode })}>{t(mode === "router" ? "engine.modeShared" : "engine.modeSeparate")}</button>)}
            </div>
          </Setting>
          {settings.serverMode === "router" ? <>
            <Setting label={t("router.host")} help={t("engine.hostHint")}><Input value={routerHost} onChange={event => setRouterHost(event.target.value)}/></Setting>
            <Setting label={t("router.port")}><Input type="number" min={1} max={65535} value={routerPort} onChange={event => setRouterPort(event.target.value)}/></Setting>
            <Setting label={t("router.maximum")} help={t("engine.maximumHint")}><Input type="number" min={1} max={64} value={routerMaxLoaded} onChange={event => setRouterMaxLoaded(event.target.value)}/></Setting>
          </> : <p className="engineNote">{t("engine.singlePorts")}</p>}
          <Setting label={t("router.apiKey")} help={t("engine.keyHint")}>
            <div className="apiKeyControl"><Input type={showRouterApiKey ? "text" : "password"} autoComplete="new-password" value={routerApiKey} onChange={event => setRouterApiKey(event.target.value)}/>
              <Button className="kIconBtn" title={showRouterApiKey ? t("actions.hide") : t("actions.show")} aria-label={showRouterApiKey ? t("actions.hide") : t("actions.show")} onClick={() => setShowRouterApiKey(value => !value)}>{showRouterApiKey ? <EyeOff size={14}/> : <Eye size={14}/>}</Button>
              <Button className="kIconBtn" title={t("actions.copy")} aria-label={t("actions.copy")} disabled={!routerApiKey} onClick={() => void copyRouterApiKey()}><Copy size={14}/></Button>
              <Button className="kIconBtn" title={t("router.generateApiKey")} aria-label={t("router.generateApiKey")} disabled={saving || busy} onClick={() => void regenerateRouterApiKey()}><Shuffle size={14}/></Button>
            </div>
          </Setting>
        </Panel>
      </>}

      {settings.serverEngine === "strata" && <>
        <Panel className="settingsSection engineBlock">
          <h3><Layers size={15}/>{t("engine.model")}</h3>
          <Setting label={t("settings.strataConfig")}>
            <div className="pathControl enginePath">
              <Select searchable value={strataConfigPath} onChange={event => setStrataConfigPath(event.target.value)}>
                <option value="">{t("settings.strataNoModels")}</option>
                {strataModels.map(model => <option value={model.configPath} key={model.configPath}>{model.modelName} · {model.contextLength ? `${Math.round(model.contextLength / 1024)}K` : "—"}</option>)}
              </Select>
              <Button className="kIconBtn" title={t("settings.strataDetect")} aria-label={t("settings.strataDetect")} onClick={() => void findStrataModels()}><RefreshCw size={14}/></Button>
            </div>
          </Setting>
          {!strataModels.length && <div className="engineInstall isHint"><div><span>{t("engine.noStrataModels")}</span><Button className="primary" onClick={() => { useControlStore.setState({ settingsOpen: false }); setView("models"); }}><Download size={14}/>{t("engine.getModel")}</Button></div></div>}
          {strataDiscoveryError && (strataModels.length ? <FriendlyInlineError error={strataDiscoveryError}/> : <details className="engineDetails"><summary>{t("components.details")}</summary><pre>{strataDiscoveryError}</pre></details>)}
          <Setting label={t("settings.strataFolder")}>
            <div className="pathControl enginePath"><Input value={strataRootPath} onChange={event => setStrataRootPath(event.target.value)}/><Button onClick={async () => {
              const path = await pickDirectory();
              if (path) { setStrataRootPath(path); await findStrataModels(path); }
            }}>{t("actions.browse")}</Button></div>
          </Setting>
        </Panel>
        <StrataEngines rootPath={settings.strataRootPath}/>
        <Panel className="settingsSection engineBlock routerSettings">
          <h3><Server size={15}/>{t("engine.server")}<span className="engineHeadNote">{t("engine.restartNote")}</span></h3>
          <Setting label={t("engine.models")} help={t(settings.strataServerMode === "router" ? "engine.modeRouterHint" : "engine.modeSingleHint")}>
            <div className="engineSegmented" role="radiogroup" aria-label={t("engine.models")}>
              {(["router", "single"] as const).map(mode => <button type="button" role="radio" key={mode} aria-checked={settings.strataServerMode === mode} onClick={() => void applySettings({ strataServerMode: mode })}>{t(mode === "router" ? "engine.modeShared" : "engine.modeSeparate")}</button>)}
            </div>
          </Setting>
          <Setting label={t("settings.strataHost")} help={t("engine.hostHint")}><Input value={strataHost} onChange={event => setStrataHost(event.target.value)}/></Setting>
          {settings.strataServerMode === "router"
            ? <Setting label={t("engine.sharedPort")} help={t("engine.sharedPortHint")}><Input type="number" min={1} max={65535} value={strataPort} onChange={event => setStrataPort(event.target.value)}/></Setting>
            : <Setting label={t("engine.firstPort")} help={t("engine.firstPortHint")}><Input type="number" min={1} max={65535} value={strataPort} onChange={event => setStrataPort(event.target.value)}/></Setting>}
          {settings.strataServerMode === "router" && <StrataRouterState/>}
          <Setting label={t("settings.strataApiKey")} help={t("engine.strataKeyHint")}><Input type="password" autoComplete="new-password" value={strataApiKey} onChange={event => setStrataApiKey(event.target.value)}/></Setting>
        </Panel>
      </>}
      </div>
      <div className="settingsColumn settingsGeneralColumn">

      <Panel className="settingsSection">
        <h3>{t("settings.general")}</h3>
        <Setting label={t("settings.language")}><Select value={settings.language} onChange={event => void applySettings({ language: event.target.value as AppLanguage })}>{APP_LANGUAGES.map(language => <option key={language.code} value={language.code} lang={language.code}>{language.nativeName}</option>)}</Select></Setting>
        <Setting label={t("settings.theme")}><Select value={settings.theme} onChange={event => void applySettings({ theme: event.target.value as ThemePreference })}><option value="dark">{t("settings.themeDark")}</option><option value="light">{t("settings.themeLight")}</option><option value="system">{t("settings.themeSystem")}</option></Select></Setting>
        <Setting label={t("settings.uiScale")} help={t("settings.uiScaleHelp")}><Select value={settings.uiScale} onChange={event => void applySettings({ uiScale: Number(event.target.value) })}><option value={0}>{t("settings.uiScaleAuto")}</option><option value={0.9}>90%</option><option value={1}>100%</option><option value={1.1}>110%</option><option value={1.2}>120%</option><option value={1.3}>130%</option><option value={1.4}>140%</option><option value={1.5}>150%</option></Select></Setting>
        <Setting label={t("density.label")} help={t("density.help")}><Select value={density} onChange={event => useUiPrefs.getState().setDensity(event.target.value as Density)}><option value="auto">{t("density.auto")}</option><option value="comfortable">{t("density.comfortable")}</option><option value="compact">{t("density.compact")}</option></Select></Setting>
        <Setting label={t("sidebarPin.label")} help={t("sidebarPin.help")}><Switch checked={sidebarPinned} onChange={value => useUiPrefs.getState().setSidebarPinned(value)}/></Setting>
        {isTauri() && <Setting label={t("mica.label")} help={t("mica.help")}><Switch checked={mica} onChange={value => useUiPrefs.getState().setMica(value)}/></Setting>}
        {isTauri() && <Setting label={t("mini.label")} help={t("mini.help")}><Button onClick={() => void toggleMiniWindow()}>{t("mini.toggle")}</Button></Setting>}
        <Setting label={t("settings.pollInterval")}><Select value={settings.pollIntervalMs} onChange={event => void applySettings({ pollIntervalMs: Number(event.target.value) })}><option value={500}>500 ms</option><option value={1000}>1 s</option><option value={2000}>2 s</option><option value={5000}>5 s</option></Select></Setting>
        <Setting label={t("settings.autoStart")}><Switch checked={settings.autoStartServer} onChange={value => void applySettings({ autoStartServer: value })}/></Setting>
        <Setting label={t("settings.startWindows")}><Switch checked={settings.startWithWindows} onChange={value => void applySettings({ startWithWindows: value })}/></Setting>
        <Setting label={t("settings.minimizeTray")}><Switch checked={settings.minimizeToTray} onChange={value => void applySettings({ minimizeToTray: value })}/></Setting>
        <Setting label={t("settings.closeTray")}><Switch checked={settings.closeToTray} onChange={value => void applySettings({ closeToTray: value })}/></Setting>
      </Panel>
      </div>
    </div>:null}</div></div>
    <footer className="settingsWindowFooter" role="status">{(section==='general'||section==='engine')&&<span className={`settingsAutosave${autoError ? " isError" : ""}`}>{autoError || t(saving ? "settings.autosaving" : savedAt ? "settings.autosaved" : "settings.autosaveHint")}</span>}</footer>
  </div>;
}

function isLoopback(host: string) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}
