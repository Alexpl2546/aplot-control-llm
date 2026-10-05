import { Boxes, Layers3, Plus, RefreshCw, Upload, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, SectionTitle } from "../components/ui/Primitives";
import { chooseModelLocation } from "../services/modelImport";
import { pickDirectory, pickProfileJson } from "../services/dialog";
import { importOllama, pullOllama, startOllama } from "../services/ollama";
import { pickGguf } from "../services/dialog";
import { mergeModelDirectories } from "../lib/modelDirectories";
import { useControlStore } from "../store/control";
import type { LibraryEngineFilter } from "./ModelsView";
import { ModelsView } from "./ModelsView";
import type { ModelCapability, ModelUse } from "../lib/modelCatalog";
import { ProfilesView } from "./ProfilesView";

type LibraryTab = "models" | "profiles";

export function LibraryView({ initialTab = "models" }: { initialTab?: LibraryTab }) {
  const { t } = useTranslation();
  const { activeView, profiles, rescanModels, duplicateProfile, importProfile, busy, settings, notify } = useControlStore();
  const strataCount = useControlStore(state => state.strataModels.length);
  const [modelName, setModelName] = useState("");
  const [importing, setImporting] = useState(false);
  const performOllama = async (importFile: boolean) => {
    if (!modelName.trim()) return;
    const path = importFile ? await pickGguf() : undefined; if (importFile && !path) return;
    setImporting(true); useControlStore.setState({ busy: true });
    try { await startOllama(settings.ollamaEndpoint, settings.ollamaBinaryPath); if (path) await importOllama(settings.ollamaEndpoint, settings.ollamaBinaryPath, path, modelName.trim()); else await pullOllama(settings.ollamaEndpoint, modelName.trim()); await rescanModels(); notify("success", t("models.ollamaAdded")); } catch (error) { notify("error", String(error)); } finally { useControlStore.setState({ busy: false }); setImporting(false); }
  };
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [engine, setEngine] = useState<LibraryEngineFilter>("all");

  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [capabilities, setCapabilities] = useState<ModelCapability[]>([]);
  const [application, setApplication] = useState<ModelUse | "all">("all");

  useEffect(() => setTab(activeView === "profiles" ? "profiles" : initialTab), [activeView, initialTab]);

  const importFromJson = async () => {
    const path = await pickProfileJson();
    if (path) await importProfile(path);
  };
  const addModels = async () => {
    const path = await pickDirectory(); if (!path) return;
    const added = await chooseModelLocation(path); if (!added) return;
    const state = useControlStore.getState();
    await state.updateSettings({ modelDirectories: mergeModelDirectories(state.settings.modelDirectories, added) });
    await state.rescanModels();
  };
  const action = tab === "models"
    ? <div className="toolbar"><Button className="primary" disabled={busy || engine === "strata"} onClick={() => void addModels()}><Plus size={15}/>{t("models.addModels")}</Button><Button disabled={busy} onClick={() => void rescanModels()}><RefreshCw size={14}/>{t("models.rescan")}</Button></div>
    : !["strata", "qwfnfer"].includes(engine) && <div className="toolbar"><Button disabled={busy} onClick={() => void importFromJson()}><Upload size={14}/>{t("actions.import")}</Button><Button className="primary" disabled={busy} onClick={() => void duplicateProfile(t("profiles.newName"))}><Plus size={14}/>{t("profiles.new")}</Button></div>;

  return <div className="page libraryPage">
    <SectionTitle title={t("nav.library")} description={t(tab === "models" ? "models.description" : "profiles.description")} action={action}/>
    <div className="libraryToolbar"><Input className="librarySearch" aria-label={t("library.search")} placeholder={t("library.search")} value={search} onChange={event => setSearch(event.target.value)}/>
      <div className="libraryTabs" role="tablist" aria-label={t("nav.library")}>
        <button role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Boxes size={15}/>{t("library.modelsTab")}</button>
        <button role="tab" aria-selected={tab === "profiles"} className={tab === "profiles" ? "active" : ""} onClick={() => setTab("profiles")}><Layers3 size={15}/>{t("library.profilesTab")}<span className="libraryCount">{engine === "qwfnfer" ? Number(Boolean(settings.qwfn.modelPath)) : engine === "strata" ? strataCount : profiles.filter(profile => engine === "all" || (profile.config.engine ?? "llama_cpp") === engine).length + (engine === "all" ? strataCount + Number(Boolean(settings.qwfn.modelPath)) : 0)}</span></button>
      </div>
      <div className="libraryFilters" role="group" aria-label={t("library.engineFilter")}>
        {(["all", "llama_cpp", "strata", "ollama", "qwfnfer"] as const).map(value => <button key={value} data-engine={value === "all" ? undefined : value} className={engine === value ? "active" : ""} aria-pressed={engine === value} onClick={() => setEngine(value)}>{t(`library.engine.${value}`)}</button>)}
      </div>
    </div>
    {tab === "models" && <div className="modelFilterBar">
      <label><input type="checkbox" checked={favoritesOnly} onChange={event => setFavoritesOnly(event.target.checked)}/>{t("models.onlyFavorites")}</label>
      <div className="libraryFilters" role="group" aria-label={t("models.support")}>
        {(["text", "vision", "tools"] as const).map(value => <button key={value} className={capabilities.includes(value) ? "active" : ""} aria-pressed={capabilities.includes(value)} onClick={() => setCapabilities(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])}>{value === "vision" ? "Vision" : t(`models.${value}`)}</button>)}
      </div>
      <select className="uiSelect" aria-label={t("models.application")} value={application} onChange={event => setApplication(event.target.value as ModelUse | "all")}><option value="all">{t("models.allApplications")}</option>{(["coding", "analysis", "agents", "chat", "creative", "documents"] as const).map(value => <option key={value} value={value}>{t(`models.use.${value}`)}</option>)}</select>
      {(favoritesOnly || capabilities.length > 0 || application !== "all") && <Button onClick={() => { setFavoritesOnly(false); setCapabilities([]); setApplication("all"); }}>{t("models.resetFilters")}</Button>}
      <small>{t("models.capabilityFilterHint")}</small>
    </div>}
    {tab === "models" && (engine === "ollama" || settings.serverEngine === "ollama") && <div className="toolbar ollamaLibraryImport"><Input aria-label={t("models.ollamaName")} placeholder="qwen2.5:0.5b" value={modelName} disabled={importing} onChange={event => setModelName(event.target.value)}/><Button disabled={importing || busy || !modelName.trim()} onClick={() => void performOllama(false)}><Download size={14}/>{t("models.ollamaDownload")}</Button><Button disabled={importing || busy || !modelName.trim()} onClick={() => void performOllama(true)}><Upload size={14}/>{t("models.ollamaImport")}</Button>{importing && <span role="status">{t("models.importing")}</span>}</div>}
    {tab === "models" ? <ModelsView embedded engineFilter={engine} search={search} favoritesOnly={favoritesOnly} capabilities={capabilities} application={application}/> : <ProfilesView embedded engineFilter={engine} search={search}/>}
  </div>;
}
