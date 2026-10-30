import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, ChevronRight, Download, File, FileText, Folder, FolderPlus, HardDrive, Home, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Primitives";
import { WorkspaceDialog } from "../agent/WorkspacePanels";
import { lastFolder, rememberFolder, useFilePicker, type PickerOptions } from "../../services/filePicker";
import "./filePicker.css";

interface Entry { name: string; path: string; directory: boolean; size: number; modified: number }
interface Folder { path: string; parent?: string | null; entries: Entry[] }
interface Place { kind: "home" | "desktop" | "documents" | "downloads" | "drive"; name: string; path: string }

const PLACE_ICON = { home: Home, desktop: Monitor, documents: FileText, downloads: Download, drive: HardDrive };
const sizeText = (bytes: number, language: string) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toLocaleString(language, { maximumFractionDigits: 1 })} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toLocaleString(language, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "") || path;
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

/** Renders the picker requested through services/filePicker. */
export function FilePickerHost() {
  const request = useFilePicker(state => state.request);
  return request ? <FilePicker key={request.id} options={request.options}/> : null;
}

function FilePicker({ options }: { options: PickerOptions }) {
  const { t, i18n } = useTranslation();
  const finish = useFilePicker(state => state.finish);
  const [places, setPlaces] = useState<Place[]>([]);
  const [folder, setFolder] = useState<Folder>();
  const [address, setAddress] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState(0);
  const [fileName, setFileName] = useState(options.save ? nameOf(options.defaultPath ?? "") : "");
  const [error, setError] = useState("");
  const [naming, setNaming] = useState<string>();
  const filters = options.filters ?? [];
  const extensions = filters[filter]?.extensions.map(ext => ext.toLowerCase());

  const load = useCallback(async (path: string) => {
    try {
      const next = await invoke<Folder>("browse_folder", { path });
      setFolder(next); setAddress(next.path); setSelected([]); setError("");
      rememberFolder(next.path);
    } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => {
    void invoke<Place[]>("browse_places").then(list => {
      setPlaces(list);
      const start = options.defaultPath ? (options.save || !options.directory ? parentOf(options.defaultPath) : options.defaultPath) : lastFolder() ?? list.find(place => place.kind === "documents")?.path ?? list[0]?.path;
      if (start) void load(start);
    }).catch(reason => setError(String(reason)));
  }, [load, options]);

  // Folders always show; files only when picking files and only of the chosen type.
  const visible = useMemo(() => (folder?.entries ?? []).filter(entry => entry.directory || (!options.directory && (!extensions?.length || extensions.includes(entry.name.split(".").pop()?.toLowerCase() ?? "")))), [folder, options.directory, extensions]);
  const crumbs = useMemo(() => {
    const parts = (folder?.path ?? "").split(/[\\/]/).filter(Boolean);
    return parts.map((part, index) => ({ name: part, path: parts.slice(0, index + 1).join("\\") + (index === 0 ? "\\" : "") }));
  }, [folder]);

  const choose = (paths: string[]) => {
    if (!paths.length) return;
    finish(options.multiple ? paths : paths[0]);
  };
  const confirm = () => {
    if (!folder) return;
    if (options.save) { const name = fileName.trim(); if (name) choose([`${folder.path.replace(/[\\/]$/, "")}\\${name}`]); return; }
    if (options.directory) { choose(selected.length ? selected : [folder.path]); return; }
    choose(selected.filter(path => !folder.entries.find(entry => entry.path === path)?.directory));
  };
  const activate = (entry: Entry) => {
    if (entry.directory) { void load(entry.path); return; }
    if (options.save) { setFileName(entry.name); return; }
    choose([entry.path]);
  };
  const click = (entry: Entry, additive: boolean) => {
    if (options.save && !entry.directory) setFileName(entry.name);
    if (entry.directory && !options.directory) return;
    setSelected(current => additive && options.multiple ? current.includes(entry.path) ? current.filter(path => path !== entry.path) : [...current, entry.path] : [entry.path]);
  };
  const createFolder = async () => {
    if (!folder || !naming?.trim()) { setNaming(undefined); return; }
    try { const path = await invoke<string>("browse_create_folder", { parent: folder.path, name: naming }); setNaming(undefined); await load(path); }
    catch (reason) { setError(String(reason) === "invalid-folder-name" ? t("picker.badName") : String(reason)); }
  };
  const title = options.title ?? t(options.save ? "picker.saveTitle" : options.directory ? "picker.folderTitle" : options.multiple ? "picker.filesTitle" : "picker.fileTitle");
  const canConfirm = options.save ? !!fileName.trim() : options.directory ? !!folder : selected.some(path => !folder?.entries.find(entry => entry.path === path)?.directory);

  return <WorkspaceDialog title={title} wide onClose={() => finish(null)}>
    <div className="filePicker">
      <nav className="filePickerPlaces" aria-label={t("picker.places")}>
        {places.map(place => { const Icon = PLACE_ICON[place.kind]; return <button type="button" key={place.path} className={folder?.path === place.path ? "isOn" : ""} onClick={() => void load(place.path)}><Icon size={15}/><span>{place.kind === "drive" ? place.name : t(`picker.place.${place.kind}`)}</span></button>; })}
      </nav>
      <section className="filePickerMain">
        <div className="filePickerBar">
          <button type="button" className="kIconBtn" disabled={!folder?.parent} aria-label={t("picker.up")} title={t("picker.up")} onClick={() => folder?.parent && void load(folder.parent)}><ArrowUp size={15}/></button>
          <form className="filePickerAddress" onSubmit={event => { event.preventDefault(); void load(address); }}>
            <div className="filePickerCrumbs" aria-hidden="true">{crumbs.map((crumb, index) => <span key={crumb.path}>{index > 0 && <ChevronRight size={12}/>}<button type="button" tabIndex={-1} onClick={() => void load(crumb.path)}>{crumb.name}</button></span>)}</div>
            <input aria-label={t("picker.address")} value={address} onChange={event => setAddress(event.target.value)}/>
          </form>
          <button type="button" className="kIconBtn" aria-label={t("picker.refresh")} title={t("picker.refresh")} onClick={() => folder && void load(folder.path)}><RefreshCw size={14}/></button>
          {(options.directory || options.save) && <button type="button" className="kIconBtn" aria-label={t("picker.newFolder")} title={t("picker.newFolder")} onClick={() => setNaming("")}><FolderPlus size={15}/></button>}
        </div>
        {naming !== undefined && <form className="filePickerNewFolder" onSubmit={event => { event.preventDefault(); void createFolder(); }}><Folder size={15}/><input autoFocus value={naming} placeholder={t("picker.newFolderName")} onChange={event => setNaming(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setNaming(undefined); } }}/><Button type="submit" className="primary">{t("picker.create")}</Button></form>}
        {error && <p className="filePickerError" role="alert">{error}</p>}
        <div className="filePickerList" role="listbox" aria-multiselectable={options.multiple} aria-label={folder?.path}>
          {visible.length === 0 && <p className="filePickerEmpty">{t(options.directory ? "picker.noFolders" : "picker.empty")}</p>}
          {visible.map(entry => <button type="button" role="option" aria-selected={selected.includes(entry.path)} key={entry.path} className={`filePickerRow${selected.includes(entry.path) ? " isSelected" : ""}`}
            onClick={event => click(entry, event.ctrlKey || event.metaKey)} onDoubleClick={() => activate(entry)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); activate(entry); } }}>
            {entry.directory ? <Folder size={16} className="isFolder"/> : <File size={16}/>}
            <span className="filePickerName">{entry.name}</span>
            <span className="filePickerSize">{entry.directory ? "" : sizeText(entry.size, i18n.language)}</span>
            <span className="filePickerDate">{entry.modified ? new Date(entry.modified).toLocaleDateString(i18n.language) : ""}</span>
          </button>)}
        </div>
        <footer className="filePickerFooter">
          {options.save && <input className="filePickerFileName" aria-label={t("picker.fileName")} placeholder={t("picker.fileName")} value={fileName} onChange={event => setFileName(event.target.value)}/>}
          {!options.save && <span className="filePickerSelection">{options.directory ? (selected[0] ?? folder?.path ?? "") : selected.map(nameOf).join(", ")}</span>}
          {filters.length > 1 && <select aria-label={t("picker.type")} value={filter} onChange={event => setFilter(Number(event.target.value))}>{filters.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}</select>}
          {filters.length === 1 && <span className="filePickerType">{filters[0].name} (*.{filters[0].extensions.join(", *.")})</span>}
          <Button onClick={() => finish(null)}>{t("aw.cancel")}</Button>
          <Button className="primary" disabled={!canConfirm} onClick={confirm}>{t(options.save ? "picker.save" : options.directory ? "picker.chooseFolder" : "picker.choose")}</Button>
        </footer>
      </section>
    </div>
  </WorkspaceDialog>;
}
