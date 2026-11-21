import { Boxes, Download, FolderOpen, LayoutGrid, Layers3, List, Plus, RefreshCw, SlidersHorizontal, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "../components/ui/Primitives";
import { chooseModelLocation } from "../services/modelImport";
import { pickDirectory, pickProfileJson } from "../services/dialog";
import { mergeModelDirectories } from "../lib/modelDirectories";
import { useControlStore } from "../store/control";
import type { LibraryEngineFilter } from "./ModelsView";
import { ModelsView } from "./ModelsView";
import type { ModelCapability, ModelUse } from "../lib/modelCatalog";
import { ProfilesView } from "./ProfilesView";
import { ArtifactCatalogPanel } from "../features/models/ArtifactCatalogPanel";
import { DownloadModelDialog } from "../features/modelDownloads/DownloadModelDialog";
import { WorkspaceDialog } from '../features/agent/WorkspacePanels';
import { useModelDownloadStore } from '../features/modelDownloads/store';
import { ModelCatalogDialog } from '../features/modelDownloads/ModelCatalogDialog';
import { useAcquisitionStore } from '../features/modelDownloads/acquisition';
import { DownloadsPanel } from "../features/modelDownloads/DownloadsPanel";
import type { ServerEngine } from "../types/app";
import "../features/modelDownloads/modelDownloads.css";
import { useCatalogRequest } from "../features/modelDownloads/catalogRequest";

type LibraryTab = "models" | "profiles";

export function LibraryView({ initialTab: tab = "models" }: { initialTab?: LibraryTab }) {
  const { t } = useTranslation();
  const { profiles, rescanModels, duplicateProfile, importProfile, busy, notify, availableEngines, setView } = useControlStore();
  const [search, setSearch] = useState("");
  const [engine, setEngine] = useState<LibraryEngineFilter>("all");
  const [catalogOpen,setCatalogOpen]=useState(false);
  const [catalogEngine,setCatalogEngine]=useState<ServerEngine>();
  const preparation=useAcquisitionStore(state=>state.preparation);
  const [downloadsOpen,setDownloadsOpen]=useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  // Many models read better as rows; the choice is remembered on this computer.
  const [list,setList]=useState(()=>{try{return localStorage.getItem("aplot.library.view")==="list";}catch{return false;}});
  const chooseView=(next:boolean)=>{setList(next);try{localStorage.setItem("aplot.library.view",next?"list":"grid");}catch{/* this session only */}};
  const downloadCount=useModelDownloadStore(state=>state.tasks.length);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadSource, setDownloadSource] = useState('');
  const [downloadDestination, setDownloadDestination] = useState('');

  const catalogRequested = useCatalogRequest(state => state.requested);
  useEffect(() => { if (catalogRequested) { useCatalogRequest.getState().clear(); setCatalogEngine(undefined); setCatalogOpen(true); } }, [catalogRequested]);
  useEffect(() => { if (engine !== "all" && !availableEngines.includes(engine)) setEngine("all"); }, [engine, availableEngines]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [capabilities, setCapabilities] = useState<ModelCapability[]>([]);
  const [application, setApplication] = useState<ModelUse | "all">("all");

  const importFromJson = async () => {
    try { const path = await pickProfileJson(); if (path) await importProfile(path); }
    catch (error) { notify("error", String(error)); }
  };
  const addModels = async () => {
    const path = await pickDirectory(); if (!path) return;
    const added = await chooseModelLocation(path); if (!added) return;
    const state = useControlStore.getState();
    await state.updateSettings({ modelDirectories: mergeModelDirectories(state.settings.modelDirectories, added) });
    await state.rescanModels();
  };
  const extraFilters = Number(favoritesOnly) + capabilities.length + Number(application !== "all");
  const action = tab === "models"
    ? <div className="toolbar">
      <Button aria-expanded={downloadsOpen} onClick={() => setDownloadsOpen(!downloadsOpen)}><Download size={15}/>{t("downloads.queueTitle")} {(downloadCount > 0 || preparation) && <span className="downloadsCount">{downloadCount + (preparation ? 1 : 0)}</span>}</Button>
      <Button aria-haspopup="dialog" onClick={() => setFilesOpen(true)}><FolderOpen size={15}/>{t("library.modelFiles")}</Button>
      <Button className="primary" onClick={() => { setCatalogEngine(undefined); setCatalogOpen(true); }}>{t("downloads.newDownload")}</Button>
    </div>
    : <div className="toolbar"><Button disabled={busy} onClick={() => void importFromJson()}><Upload size={14}/>{t("actions.import")}</Button><Button className="primary" disabled={busy} onClick={() => void duplicateProfile(t("profiles.newName")).catch(error => notify("error", String(error)))}><Plus size={14}/>{t("profiles.new")}</Button></div>;

  return <div className="page libraryPage">
    <div className="libraryActions">
      <div className="libraryTabs" role="tablist" aria-label={t("nav.library")}>
        <button type="button" role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => setView("models")}><Boxes size={15}/>{t("library.installed")}</button>
        <button type="button" role="tab" aria-selected={tab === "profiles"} className={tab === "profiles" ? "active" : ""} onClick={() => setView("profiles")}><Layers3 size={15}/>{t("library.profilesTab")}<span className="libraryCount">{profiles.filter(profile => engine === "all" || (profile.config.engine ?? "llama_cpp") === engine).length}</span></button>
      </div>
      {action}
    </div>
    {tab === "models" && downloadsOpen && <section className="libraryDownloads" aria-label={t("downloads.queueTitle")}><button type="button" className="kIconBtn libraryDownloadsClose" aria-label={t("actions.close")} title={t("actions.close")} onClick={()=>setDownloadsOpen(false)}><X size={14}/></button><DownloadsPanel/></section>}
    <div className="libraryToolbar">
      <Input className="librarySearch" type="search" aria-label={t("library.search")} placeholder={t("library.search")} value={search} onChange={event => setSearch(event.target.value)}/>
      <div className="libraryFilters" role="group" aria-label={t("library.engineFilter")}>
        {(["all", ...availableEngines] as const).map(value => <button key={value} data-engine={value === "all" ? undefined : value} className={engine === value ? "active" : ""} aria-pressed={engine === value} onClick={() => setEngine(value)}>{t(`library.engine.${value}`)}</button>)}
      </div>
      {tab === "models" && <>
        <Button aria-expanded={filtersOpen} aria-controls={filtersOpen ? "library-model-filters" : undefined} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={14}/>{t("library.filters")}{extraFilters > 0 && <span className="libraryCount">{extraFilters}</span>}</Button>
        <div className="libraryFilters libraryViewToggle" role="group" aria-label={t("models.view")}><button type="button" aria-pressed={!list} className={!list ? "active" : ""} title={t("models.viewGrid")} aria-label={t("models.viewGrid")} onClick={() => chooseView(false)}><LayoutGrid size={14}/></button><button type="button" aria-pressed={list} className={list ? "active" : ""} title={t("models.viewList")} aria-label={t("models.viewList")} onClick={() => chooseView(true)}><List size={14}/></button></div>
      </>}
    </div>
    {!availableEngines.length && <div className="serverHeroNotice" role="status"><p>{t("engines.none")}</p><Button onClick={() => setView("settings")}>{t("nav.settings")}</Button></div>}
    {tab === "models" && filtersOpen && <div className="modelFilterBar" id="library-model-filters">
      <label><input type="checkbox" checked={favoritesOnly} onChange={event => setFavoritesOnly(event.target.checked)}/>{t("models.onlyFavorites")}</label>
      <div className="libraryFilters" role="group" aria-label={t("models.support")}>
        {(["text", "vision", "tools"] as const).map(value => <button key={value} className={capabilities.includes(value) ? "active" : ""} aria-pressed={capabilities.includes(value)} onClick={() => setCapabilities(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])}>{value === "vision" ? "Vision" : t(`models.${value}`)}</button>)}
      </div>
      <Select className="uiSelect" aria-label={t("models.application")} value={application} onChange={event => setApplication(event.target.value as ModelUse | "all")}><option value="all">{t("models.allApplications")}</option>{(["coding", "analysis", "agents", "chat", "creative", "documents"] as const).map(value => <option key={value} value={value}>{t(`models.use.${value}`)}</option>)}</Select>
      {(favoritesOnly || capabilities.length > 0 || application !== "all") && <Button onClick={() => { setFavoritesOnly(false); setCapabilities([]); setApplication("all"); }}>{t("models.resetFilters")}</Button>}
    </div>}
    {tab === "models" ? <ModelsView embedded list={list} engineFilter={engine} search={search} favoritesOnly={favoritesOnly} capabilities={capabilities} application={application} onPrepareStrata={() => { setCatalogEngine("strata"); setCatalogOpen(true); }}/> : <ProfilesView embedded engineFilter={engine} search={search}/>}
    {filesOpen && <WorkspaceDialog title={t("library.modelFiles")} wide onClose={() => setFilesOpen(false)}>
      <div className="toolbar libraryFileActions">
        <Button disabled={busy} onClick={() => void addModels().catch(error => notify("error", String(error)))}><Plus size={15}/>{t("models.addModels")}</Button>
        <Button disabled={busy} onClick={() => void rescanModels().catch(error => notify("error", String(error)))}><RefreshCw size={14}/>{t("models.rescan")}</Button>
      </div>
      <ArtifactCatalogPanel/>
    </WorkspaceDialog>}
    {catalogOpen&&<ModelCatalogDialog initialEngine={catalogEngine??(engine==='all'?useControlStore.getState().settings.serverEngine||'llama_cpp':engine)} onClose={()=>setCatalogOpen(false)} onAdvanced={(source,destination)=>{setDownloadSource(source??'');setDownloadDestination(destination??'');setCatalogOpen(false);setDownloadOpen(true);}} onQueued={()=>setDownloadsOpen(true)}/>}
    <DownloadModelDialog open={downloadOpen} initialSource={downloadSource} initialDestination={downloadDestination} onQueued={()=>setDownloadsOpen(true)} onClose={() => setDownloadOpen(false)}/>
  </div>;
}
