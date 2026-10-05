import { Copy, Eye, EyeOff, RefreshCw, Save, Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import type { AppLanguage, ServerEngine, StrataModelOption, ThemePreference } from "../types/app";
import { Button, Input, Panel, SectionTitle, Select, Switch } from "../components/ui/Primitives";
import { chooseModelLocation } from "../services/modelImport";
import { pickDirectory, pickExecutable } from "../services/dialog";
import { discoverStrataModels } from "../services/tauri";
import { OllamaEngineSettings } from "../components/config/OllamaEngineSettings";
import { QwfnConfiguration } from "../components/config/QwfnConfiguration";
import { SettingRow as Setting } from "../components/config/SettingRow";
import { FriendlyInlineError } from "../components/feedback/FriendlyInlineError";

function createRouterApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `aplot_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function SettingsView() {
  const { t } = useTranslation();
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
  const modelDirectoriesValue = settings.modelDirectories.join("\n");

  useEffect(() => {
    setBinary(settings.binaryPath);
    setDirectories(modelDirectoriesValue);
    setRouterHost(settings.routerHost);
    setRouterPort(String(settings.routerPort));
    setRouterMaxLoaded(String(settings.routerMaxLoadedModels));
    setRouterApiKey(settings.routerApiKey);
    setStrataRootPath(settings.strataRootPath);
    setStrataConfigPath(settings.strataConfigPath);
    setStrataHost(settings.strataHost);
    setStrataPort(String(settings.strataPort));
    setStrataApiKey(settings.strataApiKey);
  }, [settings.binaryPath, modelDirectoriesValue, settings.routerHost, settings.routerPort, settings.routerMaxLoadedModels, settings.routerApiKey, settings.strataRootPath, settings.strataConfigPath, settings.strataHost, settings.strataPort, settings.strataApiKey]);

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

  const savePaths = () => {
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
    setRouterApiKey(effectiveRouterApiKey);
    void updateSettings({
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
      strataApiKey,
    });
  };

  const regenerateRouterApiKey = async () => {
    const nextKey = createRouterApiKey();
    setRouterApiKey(nextKey);
    await updateSettings({ routerApiKey: nextKey });
    notify("success", t("router.apiKeyGenerated"));
  };
  const copyRouterApiKey = async () => {
    try { await navigator.clipboard.writeText(routerApiKey); notify("success", t("router.apiKeyCopied")); }
    catch (error) { notify("error", t("router.apiKeyCopyFailed")); useControlStore.setState({ error: String(error) }); }
  };

  return <div className="page">
    <SectionTitle title={t("nav.settings")} description={t("settings.description")} action={<Button className="primary" onClick={savePaths}><Save size={14}/>{t("actions.save")}</Button>}/>
    <div className="settingsGrid">
      <div className="settingsColumn settingsEngineColumn">
      <Panel className="settingsSection">
        <h3>{t("settings.engine")}</h3>
        <Setting label={t("settings.engine")} help={t("settings.engineHelp")}>
          <Select value={settings.serverEngine} onChange={event => {
            const engine = event.target.value as ServerEngine;
            void updateSettings({ serverEngine: engine });
            if (engine === "llama_cpp") void detectBinary(binary);
          }}>
            <option value="llama_cpp">{t("settings.engineLlama")}</option>
            <option value="strata">{t("settings.engineStrata")}</option><option value="ollama">Ollama</option>
            <option value="qwfnfer">QwFNfer</option>
          </Select>
        </Setting>
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

      {settings.serverEngine === "qwfnfer" ? <QwfnConfiguration/> : settings.serverEngine === "strata" ? <Panel className="settingsSection routerSettings">
        <h3>{t("settings.strataTitle")}</h3>
        <p className="subtle">{t("settings.strataInstallHelp")}</p>
        <Setting label={t("settings.strataFolder")} help={t("settings.strataFolderHelp")}>
          <div className="pathControl"><Input value={strataRootPath} onChange={event => setStrataRootPath(event.target.value)}/><Button onClick={async () => {
            const path = await pickDirectory();
            if (path) { setStrataRootPath(path); await findStrataModels(path); }
          }}>{t("actions.browse")}</Button><Button onClick={() => void findStrataModels()}><RefreshCw size={14}/>{t("settings.strataDetect")}</Button></div>
        </Setting>
        <Setting label={t("settings.strataConfig")} help={t("settings.strataConfigHelp")}>
          <Select value={strataConfigPath} onChange={event => setStrataConfigPath(event.target.value)}>
            <option value="">{t("settings.strataNoModels")}</option>
            {strataModels.map(model => <option value={model.configPath} key={model.configPath}>{model.modelName} · {model.contextLength ? `${Math.round(model.contextLength / 1024)}K` : "—"}</option>)}
          </Select>
        </Setting>
        {strataDiscoveryError && <FriendlyInlineError error={strataDiscoveryError}/>}
        <Setting label={t("settings.strataHost")}><Input value={strataHost} onChange={event => setStrataHost(event.target.value)}/></Setting>
        <Setting label={t("settings.strataPort")}><Input type="number" min={1} max={65535} value={strataPort} onChange={event => setStrataPort(event.target.value)}/></Setting>
        <Setting label={t("settings.strataApiKey")} help={t("settings.strataKeyHelp")}><Input type="password" autoComplete="new-password" value={strataApiKey} onChange={event => setStrataApiKey(event.target.value)}/></Setting>
      </Panel> : settings.serverEngine === "ollama" ? <OllamaEngineSettings/> : <Panel className="settingsSection routerSettings">
        <h3>{t("router.title")}</h3>
        <p className="subtle">{t("router.description")}</p>
        <p className="subtle">{t("router.toolsCompatibility")}</p>
        <p className="subtle">{t("router.restartNeeded")}</p>
        <Setting label={t("router.mode")} help={t("router.modeHelp")}>
          <Select value={settings.serverMode} onChange={event => void updateSettings({ serverMode: event.target.value as "single" | "router" })}>
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
            <Button title={t("router.generateApiKey")} onClick={() => void regenerateRouterApiKey()}><Shuffle size={14}/>{t("router.generateApiKey")}</Button>
          </div>
        </Setting>
      </Panel>}
      </div>
      <div className="settingsColumn settingsGeneralColumn">
      <Panel className="settingsSection">
        <h3>{t("settings.general")}</h3>
        <Setting label={t("settings.language")}><Select value={settings.language} onChange={event => void updateSettings({ language: event.target.value as AppLanguage })}><option value="en">English</option><option value="ru">Русский</option></Select></Setting>
        <Setting label={t("settings.theme")}><Select value={settings.theme} onChange={event => void updateSettings({ theme: event.target.value as ThemePreference })}><option value="dark">{t("settings.themeDark")}</option><option value="light">{t("settings.themeLight")}</option><option value="system">{t("settings.themeSystem")}</option></Select></Setting>
        <Setting label={t("settings.uiScale")} help={t("settings.uiScaleHelp")}><Select value={settings.uiScale} onChange={event => void updateSettings({ uiScale: Number(event.target.value) })}><option value={0.9}>90%</option><option value={1}>100%</option><option value={1.1}>110%</option><option value={1.2}>120%</option><option value={1.3}>130%</option><option value={1.4}>140%</option></Select></Setting>
        <Setting label={t("settings.pollInterval")}><Select value={settings.pollIntervalMs} onChange={event => void updateSettings({ pollIntervalMs: Number(event.target.value) })}><option value={500}>500 ms</option><option value={1000}>1 s</option><option value={2000}>2 s</option><option value={5000}>5 s</option></Select></Setting>
        <Setting label={t("settings.autoStart")}><Switch checked={settings.autoStartServer} onChange={value => void updateSettings({ autoStartServer: value })}/></Setting>
        <Setting label={t("settings.startWindows")}><Switch checked={settings.startWithWindows} onChange={value => void updateSettings({ startWithWindows: value })}/></Setting>
        <Setting label={t("settings.minimizeTray")}><Switch checked={settings.minimizeToTray} onChange={value => void updateSettings({ minimizeToTray: value })}/></Setting>
        <Setting label={t("settings.closeTray")}><Switch checked={settings.closeToTray} onChange={value => void updateSettings({ closeToTray: value })}/></Setting>
      </Panel>
      </div>
    </div>
  </div>;
}

function isLoopback(host: string) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}
