import { ConnectionsSettingsContent } from '../features/openai/OpenAiPanel';
import { AgentPresetsSettingsContent } from '../features/agent/AgentPresets';
import { openSettingsSection } from '../services/settingsWindow';
import { Copy, Eye, EyeOff, RefreshCw, Save, Shuffle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import type { AppLanguage, AppSettings, ServerEngine, StrataModelOption, ThemePreference } from "../types/app";
import { Button, Input, Panel, Select, Switch } from "../components/ui/Primitives";
import { chooseModelLocation } from "../services/modelImport";
import { pickDirectory, pickExecutable } from "../services/dialog";
import { discoverStrataModels, subscribeStrataEngineUpdate, updateStrataEngine, type StrataEngineFamily } from "../services/tauri";
import { SettingRow as Setting } from "../components/config/SettingRow";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";
import { ComponentManager } from "../components/config/ComponentManager";
import { APP_LANGUAGES } from "../lib/languages";

function createRouterApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `aplot_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function SettingsView() {
  const { t } = useTranslation();
  const section=useControlStore(state=>state.settingsSection);
  const setSection=openSettingsSection;
  const sectionContent=useRef<HTMLDivElement>(null);
  useEffect(()=>{sectionContent.current?.scrollTo({top:0});},[section]);
  const installedEngines = useControlStore(state => state.availableEngines);
  const { settings, updateSettings, detectBinary, capabilities, busy, notify } = useControlStore();
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
  const [strataUpdatingFamily, setStrataUpdatingFamily] = useState<StrataEngineFamily | null>(null);
  const [strataUpdateProgress, setStrataUpdateProgress] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const modelDirectoriesValue = settings.modelDirectories.join("\n");

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

  const runStrataEngineUpdate = async (family: StrataEngineFamily) => {
    if (strataUpdatingFamily || busy) return;
    const root = strataRootPath.trim();
    if (!root) return;
    setStrataUpdatingFamily(family);
    setStrataUpdateProgress("");
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await subscribeStrataEngineUpdate(progress => {
        if (progress.family !== family) return;
        const percent = typeof progress.percent === "number" ? ` · ${Math.round(progress.percent)}%` : "";
        setStrataUpdateProgress(`${progress.message}${percent}`);
      });
      const result = await updateStrataEngine(root, family);
      const engine = family === "qwen" ? "Qwen" : "DeepSeek";
      if (result.status === "updated") {
        notify("success", result.currentVersion ? t("settings.strataEngineUpdated", { engine, version: result.currentVersion }) : result.message);
      } else if (result.status === "upToDate") {
        notify("success", result.currentVersion ? t("settings.strataEngineUpToDate", { engine, version: result.currentVersion }) : result.message);
      } else {
        notify("error", result.status === "notInstalled" ? t("settings.strataEngineNotInstalled", { engine }) : result.message);
      }
    } catch (error) {
      notify("error", String(error));
    } finally {
      unlisten?.();
      setStrataUpdatingFamily(null);
      setStrataUpdateProgress("");
    }
  };

  const savePaths = async () => {
    if (savingRef.current || busy) return;
    const port = Number(routerPort);
    const maximum = Number(routerMaxLoaded);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      notify("error", t("router.invalidPort"));
      return;
    }
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64) {
      notify("error", t("router.invalidMaximum"));
      return;
    }
    const strataPortNumber = Number(strataPort);
    if (!Number.isInteger(strataPortNumber) || strataPortNumber < 1 || strataPortNumber > 65535) {
      notify("error", t("router.invalidPort"));
      return;
    }
    if (settings.serverEngine === "strata" && !isLoopback(strataHost) && !strataApiKey.trim()) {
      notify("error", t("settings.strataKeyHelp"));
      return;
    }
    const effectiveRouterApiKey = routerApiKey.trim() || createRouterApiKey();
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
      setRouterApiKey(effectiveRouterApiKey);
    } catch (error) { notify("error", String(error)); }
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
      <div className="settingsColumn settingsEngineColumn">
      <Panel className="settingsSection">
        <h3>{t("settings.engine")}</h3>
        <Setting label={t("settings.engine")} help={t("settings.engineHelp")}>
          <Select value={settings.serverEngine} onChange={event => {
            const engine = event.target.value as ServerEngine | "";
            void applySettings({ serverEngine: engine });
            if (engine === "llama_cpp" && binary.trim()) void detectBinary(binary).catch(error => notify("error", String(error)));
          }}>
            <option value="">{t("settings.chooseEngine")}</option>
            <option value="llama_cpp">{'llama.cpp'}{!installedEngines.includes("llama_cpp") && ` · ${t("components.absent")}`}</option>
            <option value="strata">{'Strata'}{!installedEngines.includes("strata") && ` · ${t("components.absent")}`}</option>
          </Select>
        </Setting>
        {settings.legacyEngineId && <p className="serverHeroNotice" role="status">{t("profiles.unsupportedEngine", { engine: settings.legacyEngineId })}</p>}
      </Panel>
      {settings.serverEngine === "llama_cpp" && <Panel className="settingsSection">
        <h3>llama.cpp</h3>
        <Setting label={t("settings.binary")} help={t("settings.binaryHelp")}>
          <div className="pathControl"><Input value={binary} onChange={event => setBinary(event.target.value)}/><Button onClick={async () => { const path = await pickExecutable(); if (path) setBinary(path); }}>{t("actions.browse")}</Button></div>
        </Setting>
        <div className="settingsActions"><Button disabled={busy || !binary.trim()} onClick={() => void detectBinary(binary)}><RefreshCw size={14}/>{t("settings.detect")}</Button><span>{capabilities.version}</span></div>
        <Setting label={t("settings.modelDirs")} help={t("settings.modelDirsHelp")}>
          <textarea className="uiTextarea mono" rows={4} value={directories} onChange={event => setDirectories(event.target.value)}/>
          <Button onClick={async () => { const path = await pickDirectory(); if (path) { const added = await chooseModelLocation(path); if (added) setDirectories(value => [value, added].filter(Boolean).join("\n")); } }}>{t("settings.addFolder")}</Button>
        </Setting>
      </Panel>}

      {settings.serverEngine === "strata" ? <Panel className="settingsSection routerSettings">
        <h3>{t("settings.strataTitle")}</h3>
        <p className="subtle">{t("settings.strataInstallHelp")}</p>
        <Setting label={t("settings.strataFolder")} help={t("settings.strataFolderHelp")}>
          <div className="pathControl"><Input value={strataRootPath} onChange={event => setStrataRootPath(event.target.value)}/><Button onClick={async () => {
            const path = await pickDirectory();
            if (path) { setStrataRootPath(path); await findStrataModels(path); }
          }}>{t("actions.browse")}</Button><Button onClick={() => void findStrataModels()}><RefreshCw size={14}/>{t("settings.strataDetect")}</Button></div>
        </Setting>
        <Setting label={t("settings.strataConfig")} help={t("settings.strataConfigHelp")}>
          <Select searchable value={strataConfigPath} onChange={event => setStrataConfigPath(event.target.value)}>
            <option value="">{t("settings.strataNoModels")}</option>
            {strataModels.map(model => <option value={model.configPath} key={model.configPath}>{model.modelName} · {model.contextLength ? `${Math.round(model.contextLength / 1024)}K` : "—"}</option>)}
          </Select>
        </Setting>
        {strataDiscoveryError && <FriendlyInlineError error={strataDiscoveryError}/>}
        <Setting label={t("settings.strataEngineUpdates")} help={t("settings.strataEngineUpdateHelp")}>
          <div className="pathControl">
            <Button aria-busy={strataUpdatingFamily === "qwen"} disabled={busy || Boolean(strataUpdatingFamily) || !strataRootPath.trim()} onClick={() => void runStrataEngineUpdate("qwen")}>
              <RefreshCw size={14}/>
              {strataUpdatingFamily === "qwen" ? t("settings.strataUpdatingEngine", { engine: "Qwen" }) : t("settings.strataUpdateQwen")}
            </Button>
            <Button aria-busy={strataUpdatingFamily === "deepseek"} disabled={busy || Boolean(strataUpdatingFamily) || !strataRootPath.trim()} onClick={() => void runStrataEngineUpdate("deepseek")}>
              <RefreshCw size={14}/>
              {strataUpdatingFamily === "deepseek" ? t("settings.strataUpdatingEngine", { engine: "DeepSeek" }) : t("settings.strataUpdateDeepSeek")}
            </Button>
          </div>
          {strataUpdatingFamily && <p className="subtle" role="status" aria-live="polite">{strataUpdateProgress || t("settings.strataUpdatingEngine", { engine: strataUpdatingFamily === "qwen" ? "Qwen" : "DeepSeek" })}</p>}
        </Setting>
        <Setting label={t("settings.strataHost")}><Input value={strataHost} onChange={event => setStrataHost(event.target.value)}/></Setting>
        <Setting label={t("settings.strataPort")}><Input type="number" min={1} max={65535} value={strataPort} onChange={event => setStrataPort(event.target.value)}/></Setting>
        <Setting label={t("settings.strataApiKey")} help={t("settings.strataKeyHelp")}><Input type="password" autoComplete="new-password" value={strataApiKey} onChange={event => setStrataApiKey(event.target.value)}/></Setting>
      </Panel> : settings.serverEngine === "llama_cpp" ? <Panel className="settingsSection routerSettings">
        <h3>{t("router.title")}</h3>
        <p className="subtle">{t("router.description")}</p>
        <p className="subtle">{t("router.toolsCompatibility")}</p>
        <p className="subtle">{t("router.restartNeeded")}</p>
        <Setting label={t("router.mode")} help={t("router.modeHelp")}>
          <Select value={settings.serverMode} onChange={event => void applySettings({ serverMode: event.target.value as "single" | "router" })}>
            <option value="router">{t("router.modeRouter")}</option>
            <option value="single">{t("router.modeSingle")}</option>
          </Select>
        </Setting>
        <Setting label={t("router.host")} help={t("router.hostHelp")}><Input value={routerHost} onChange={event => setRouterHost(event.target.value)}/></Setting>
        <Setting label={t("router.port")}><Input type="number" min={1} max={65535} value={routerPort} onChange={event => setRouterPort(event.target.value)}/></Setting>
        <Setting label={t("router.maximum")} help={t("router.maximumHelp")}><Input type="number" min={1} max={64} value={routerMaxLoaded} onChange={event => setRouterMaxLoaded(event.target.value)}/></Setting>
        <Setting label={t("router.autoload")} help={t("router.autoloadHelp")}><Switch checked disabled onChange={() => undefined}/></Setting>
        <Setting label={t("router.apiKey")} help={t("router.apiKeyHelp")}>
          <div className="apiKeyControl"><Input type={showRouterApiKey ? "text" : "password"} autoComplete="new-password" value={routerApiKey} onChange={event => setRouterApiKey(event.target.value)}/>
            <Button title={showRouterApiKey ? t("actions.hide") : t("actions.show")} aria-label={showRouterApiKey ? t("actions.hide") : t("actions.show")} onClick={() => setShowRouterApiKey(value => !value)}>{showRouterApiKey ? <EyeOff size={14}/> : <Eye size={14}/>}</Button>
            <Button title={t("actions.copy")} aria-label={t("actions.copy")} disabled={!routerApiKey} onClick={() => void copyRouterApiKey()}><Copy size={14}/></Button>
            <Button title={t("router.generateApiKey")} disabled={saving || busy} onClick={() => void regenerateRouterApiKey()}><Shuffle size={14}/>{t("router.generateApiKey")}</Button>
          </div>
        </Setting>
      </Panel> : <Panel className="settingsSection"><p>{t("settings.chooseEngineHelp")}</p></Panel>}
      </div>
      <div className="settingsColumn settingsGeneralColumn">

      <Panel className="settingsSection">
        <h3>{t("settings.general")}</h3>
        <Setting label={t("settings.language")}><Select value={settings.language} onChange={event => void applySettings({ language: event.target.value as AppLanguage })}>{APP_LANGUAGES.map(language => <option key={language.code} value={language.code} lang={language.code}>{language.nativeName}</option>)}</Select></Setting>
        <Setting label={t("settings.theme")}><Select value={settings.theme} onChange={event => void applySettings({ theme: event.target.value as ThemePreference })}><option value="dark">{t("settings.themeDark")}</option><option value="light">{t("settings.themeLight")}</option><option value="system">{t("settings.themeSystem")}</option></Select></Setting>
        <Setting label={t("settings.uiScale")} help={t("settings.uiScaleHelp")}><Select value={settings.uiScale} onChange={event => void applySettings({ uiScale: Number(event.target.value) })}><option value={0.9}>90%</option><option value={1}>100%</option><option value={1.1}>110%</option><option value={1.2}>120%</option><option value={1.3}>130%</option><option value={1.4}>140%</option></Select></Setting>
        <Setting label={t("settings.pollInterval")}><Select value={settings.pollIntervalMs} onChange={event => void applySettings({ pollIntervalMs: Number(event.target.value) })}><option value={500}>500 ms</option><option value={1000}>1 s</option><option value={2000}>2 s</option><option value={5000}>5 s</option></Select></Setting>
        <Setting label={t("settings.autoStart")}><Switch checked={settings.autoStartServer} onChange={value => void applySettings({ autoStartServer: value })}/></Setting>
        <Setting label={t("settings.startWindows")}><Switch checked={settings.startWithWindows} onChange={value => void applySettings({ startWithWindows: value })}/></Setting>
        <Setting label={t("settings.minimizeTray")}><Switch checked={settings.minimizeToTray} onChange={value => void applySettings({ minimizeToTray: value })}/></Setting>
        <Setting label={t("settings.closeTray")}><Switch checked={settings.closeToTray} onChange={value => void applySettings({ closeToTray: value })}/></Setting>
      </Panel>
      </div>
    </div>:null}</div></div>
    <footer className="settingsWindowFooter">{(section==='general'||section==='engine')&&<Button className="primary" disabled={saving || busy || Boolean(strataUpdatingFamily)} onClick={() => void savePaths()}><Save size={14}/>{t("actions.save")}</Button>}</footer>
  </div>;
}

function isLoopback(host: string) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}
