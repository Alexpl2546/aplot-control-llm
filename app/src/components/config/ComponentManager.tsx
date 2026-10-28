import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { ArrowRight, ArrowUpCircle, Check, ChevronDown, ExternalLink, FolderOpen, HardDrive, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { Button, Panel } from "../ui/Primitives";
import { getComponentMaintenance, isRemovedComponentPath, launchUninstaller, openUninstallSettings, removeInstalledComponents, type ComponentMaintenanceState, type InstalledModule } from "../../services/components";
import { revealItem } from "../../services/desktop";
import { useControlStore } from "../../store/control";
import { GROUPS, metaFor } from "./componentCatalog";
import { componentErrorKey, loadComponentCatalog, runComponentJobs, useComponentJobs } from "./componentJobs";
import { ComponentFailure, ComponentIcon, ComponentInstallButton, ComponentProgress, formatBytes } from "./ComponentInstall";
import { isTauri } from "@tauri-apps/api/core";
import "./ComponentManager.css";

type Status = "installed" | "external" | "absent";
type Filter = "all" | Status | "updates";
const FILTERS: Filter[] = ["all", "updates", "installed", "external", "absent"];
const statusOf = (module: InstalledModule): Status => module.paths.length > 0 ? "installed" : module.externalPath ? "external" : "absent";

export function ComponentManager() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<ComponentMaintenanceState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [confirm, setConfirm] = useState<"modules" | "app" | null>(null);
  const [loading, setLoading] = useState(true);
  const updates = useComponentJobs(state => state.catalog);
  const updating = useComponentJobs(state => state.active);
  const finished = useComponentJobs(state => state.finished);
  const revision = useComponentJobs(state => state.revision);
  const doneMode = useComponentJobs(state => state.finishedMode);
  const mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialogTitle = useId();
  const dialogText = useId();
  const desktop = isTauri();
  const titleFor = (id: string, fallback = id) => id === "cache" ? t("components.cache") : id === "python_runtime" ? t("components.python") : fallback;
  const nameOf = (id: string) => titleFor(id, modules.find(module => module.id === id)?.name ?? id);
  const formatSize = (bytes: number) => formatBytes(bytes, i18n.resolvedLanguage);
  const modules = state?.modules ?? [];
  // Shared folders only matter once something put files there.
  const visible = modules.filter(module => metaFor(module.id).group !== "shared" || module.paths.length > 0);
  const chosen = modules.filter(module => selected.includes(module.id));
  const pythonNeeded = modules.some(module => ["strata", "hermes"].includes(module.id) && module.paths.length > 0 && !selected.includes(module.id));
  const counts = Object.fromEntries(FILTERS.map(value => [value, value === "all" ? visible.length : visible.filter(module => statusOf(module) === value).length])) as Record<Filter, number>;
  const installed = visible.filter(module => module.paths.length > 0 && module.bytes > 0);
  const totalBytes = installed.reduce((sum, module) => sum + module.bytes, 0);
  const chosenBytes = chosen.reduce((sum, module) => sum + module.bytes, 0);
  const updateFor = (id: string) => updates?.installerAvailable ? updates.components.find(item => item.id === id && item.updateAvailable) : undefined;
  const updatable = visible.filter(module => module.paths.length > 0 && updateFor(module.id));
  counts.updates = updatable.length;
  const locked = busy || loading || !!updating;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Reload after every install or update, including ones started from other tabs.
  useEffect(() => { void refresh(true); }, [revision]);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    cancelButton.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, [confirm]);
  const refresh = async (keepError = false) => {
    setLoading(true); if (!keepError) setError("");
    try {
      const [next] = await Promise.all([getComponentMaintenance(), loadComponentCatalog()]);
      if (mounted.current) { setState(next); setSelected([]); }
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { if (mounted.current) setLoading(false); }
  };
  const perform = async () => {
    setBusy(true); setError(""); setDone(false);
    try {
      if (confirm === "app") { await launchUninstaller(); return; }
      const report = await removeInstalledComponents(selected);
      const removedRoots = chosen.filter(module => report.removed.includes(module.id)).flatMap(module => module.paths);
      if (removedRoots.length) {
        const store = useControlStore.getState();
        const current = store.settings;
        const missing = (path: string) => isRemovedComponentPath(path, removedRoots) ? "" : path;
        await store.updateSettings({
          binaryPath: missing(current.binaryPath), strataRootPath: missing(current.strataRootPath),
        });
      }
      if (mounted.current) { setConfirm(null); setDone(report.errors.length === 0); }
      await refresh();
      if (report.errors.length && mounted.current) setError(report.errors.join("\n"));
    } catch (reason) { if (mounted.current) { setConfirm(null); setError(String(reason)); } }
    finally { if (mounted.current) setBusy(false); }
  };
  const toggle = (id: string, checked: boolean) => {
    setDone(false);
    setSelected(previous => {
      const next = checked ? [...previous, id] : previous.filter(value => value !== id);
      return !checked && ["strata", "hermes"].includes(id) ? next.filter(value => value !== "python_runtime") : next;
    });
  };
  const run = (ids: string[], mode: "install" | "update") => { setError(""); setDone(false); void runComponentJobs(ids, mode); };
  const reveal = (path: string) => void revealItem(path).catch(reason => setError(String(reason)));
  const errorHint = t(componentErrorKey(error));

  const tag = (version: string) => !version ? "?" : /^\d/.test(version) ? `v${version}` : version;
  const renderModule = (module: InstalledModule, index: number) => {
    const status = statusOf(module);
    const present = status === "installed";
    const disabled = !present || !!module.blocked || locked || (module.id === "python_runtime" && pythonNeeded);
    const update = present ? updateFor(module.id) : undefined;
    const isUpdating = updating === module.id;
    const isSelected = selected.includes(module.id);
    const expanded = open.includes(module.id);
    const hasPaths = present || !!module.externalPath;
    const installable = status === "absent" && !!updates?.components.some(item => item.id === module.id);
    const keepPython = module.id === "python_runtime" && present && pythonNeeded;
    const pathsId = `component-paths-${module.id}`;
    return <article key={module.id} className={clsx("componentCard", `is-${status}`, isSelected && "isSelected", module.blocked && "isBlocked", update && "hasUpdate", isUpdating && "isUpdating")} style={{ "--i": index } as CSSProperties}>
      <div className="componentMain">
        <ComponentIcon id={module.id}/>
        <div className="componentText">
          <div className="componentName"><strong>{titleFor(module.id, module.name)}</strong>
            <span className={`componentStatus is-${module.blocked ? "blocked" : status}`}>{module.blocked ? <ShieldAlert size={11}/> : <i aria-hidden="true"/>}{t(module.blocked ? "components.status.blocked" : `components.status.${status}`)}</span>
            {update && <span className="componentStatus is-update"><ArrowUpCircle size={11}/>{t("components.update.badge")}</span>}
            {doneMode === "update" && finished.includes(module.id) && !update && <span className="componentStatus is-installed"><Check size={11}/>{t("components.update.done")}</span>}
          </div>
          <p>{t(`components.about.${module.id}`, { defaultValue: "" }) || (present ? t("components.shared") : "")}
            {update ? <span className="componentTag isVersion isUpgrade">{tag(update.installedVersion ?? "")}<ArrowRight size={11}/><b>{tag(update.availableVersion)}</b></span>
              : present && module.versions.map(version => <span key={version} className="componentTag isVersion">{tag(version)}</span>)}
          </p>
        </div>
        <div className="componentSide">
          {present && <span className="componentSize">{formatSize(module.bytes)}</span>}
          <div className="componentActions">
            {update && <Button className="primary componentUpdateButton" disabled={locked} title={update.downloadBytes ? t("components.update.download", { size: formatSize(update.downloadBytes) }) : undefined} onClick={() => run([module.id], "update")}>{isUpdating ? <RefreshCw size={14} className="componentSpin"/> : <ArrowUpCircle size={14}/>}{isUpdating ? t("components.update.running") : t("components.update.action")}</Button>}
            {installable && <ComponentInstallButton id={module.id}/>}
            {hasPaths && <Button className="kIconBtn" aria-expanded={expanded} aria-controls={pathsId} title={t("components.locations")} aria-label={t("components.locations")} onClick={() => setOpen(previous => expanded ? previous.filter(id => id !== module.id) : [...previous, module.id])}><ChevronDown size={15} className="componentChevron"/></Button>}
            {present && <label className="componentCheck" title={keepPython ? t("components.pythonNeeded") : t("components.select")}>
              <input type="checkbox" checked={isSelected} disabled={disabled} aria-label={`${t("components.select")}: ${titleFor(module.id, module.name)}`} onChange={event => toggle(module.id, event.target.checked)}/>
              <span aria-hidden="true"><Check size={12} strokeWidth={3}/></span>
            </label>}
          </div>
        </div>
      </div>
      <ComponentProgress id={module.id}/>
      <ComponentFailure id={module.id}/>
      {module.blocked && <p className="componentHint isWarn">{t("components.links")}</p>}
      {hasPaths && <div className="componentPaths" id={pathsId} data-open={expanded} inert={!expanded}><div>
        {module.paths.map(path => <div key={path} className="componentPath"><code title={path}>{path}</code><Button className="kIconBtn" disabled={busy} title={t("components.showFolder")} aria-label={t("components.showFolder")} onClick={() => reveal(path)}><FolderOpen size={14}/></Button></div>)}
        {module.externalPath && <div className="componentPath"><span><small>{t("components.external")}</small><code title={module.externalPath}>{module.externalPath}</code></span><Button className="kIconBtn" disabled={busy} title={t("components.showFolder")} aria-label={t("components.showFolder")} onClick={() => reveal(module.externalPath!)}><FolderOpen size={14}/></Button></div>}
      </div></div>}
    </article>;
  };

  const shown = visible.filter(module => filter === "all" || (filter === "updates" ? updatable.includes(module) : statusOf(module) === filter));
  let order = 0;
  return <Panel className="settingsSection componentManager">
    <header className="componentHeader">
      <h3>{t("components.title")}</h3>
      {state?.root && <Button className="kIconBtn" disabled={busy} title={`${t("components.openRoot")}: ${state.root}`} aria-label={t("components.openRoot")} onClick={() => reveal(state.root)}><FolderOpen size={15}/></Button>}
      <Button className={clsx("kIconBtn", loading && "isSpinning")} disabled={locked} title={t("components.refresh")} aria-label={t("components.refresh")} onClick={() => void refresh()}><RefreshCw size={15}/></Button>
    </header>
    {!desktop && <p className="componentNotice">{t("components.desktopOnly")}</p>}

    <section className="componentOverview" aria-label={t("components.summary.title")}>
      <div className="componentTotal">
        <span className="componentIcon isStore" aria-hidden="true"><HardDrive size={20}/></span>
        <div><strong>{loading && !state ? "—" : formatSize(totalBytes)}</strong><span>{t("components.summary.total")}</span></div>
        <dl>{(["installed", "external", "absent"] as const).map(value => <div key={value} className={`is-${value}`}><dt>{t(`components.filter.${value}`)}</dt><dd>{counts[value]}</dd></div>)}</dl>
      </div>
      {updatable.length > 0 && <div className="componentUpdates">
        <span className="componentIcon isUpdate" aria-hidden="true"><ArrowUpCircle size={18}/></span>
        <div><strong>{t("components.update.available", { count: updatable.length })}</strong><span>{updatable.map(module => titleFor(module.id, module.name)).join(", ")}</span></div>
        <Button className="primary" disabled={locked} onClick={() => run(updatable.map(module => module.id), "update")}><ArrowUpCircle size={14}/>{updatable.length > 1 ? t("components.update.all") : t("components.update.action")}</Button>
      </div>}
      {totalBytes > 0 && <>
        <div className="componentBar" role="img" aria-label={installed.map(module => `${titleFor(module.id, module.name)} ${formatSize(module.bytes)}`).join(", ")}>
          {installed.map((module, index) => <span key={module.id} className={clsx(selected.includes(module.id) && "isSelected")} style={{ flexGrow: module.bytes, "--c": metaFor(module.id).color, "--i": index } as CSSProperties}/>)}
        </div>
        <ul className="componentLegend">{installed.map(module => <li key={module.id} style={{ "--c": metaFor(module.id).color } as CSSProperties}><i aria-hidden="true"/>{titleFor(module.id, module.name)}<span>{formatSize(module.bytes)}</span></li>)}</ul>
      </>}
    </section>

    <div className="componentFilters" role="tablist" aria-label={t("components.filter.label")}>
      {FILTERS.filter(value => value !== "updates" || counts.updates > 0).map(value => <button type="button" role="tab" key={value} aria-selected={filter === value} onClick={() => setFilter(value)}>{t(`components.filter.${value}`)}<span>{counts[value]}</span></button>)}
    </div>

    {loading && !state && <div className="componentGroup" role="status" aria-label={t("components.loading")}>{[0, 1, 2].map(index => <div key={index} className="componentCard isSkeleton"><span/><div><i/><i/></div></div>)}</div>}
    {GROUPS.map(group => {
      const items = shown.filter(module => metaFor(module.id).group === group);
      if (!items.length) return null;
      return <section key={`${group}-${filter}`} className="componentGroup" aria-label={t(`components.group.${group}`)}>
        <h4>{t(`components.group.${group}`)}<span>{items.length}</span></h4>
        {items.map(module => renderModule(module, order++))}
      </section>;
    })}
    {!loading && state && !shown.length && <p className="componentEmpty">{t("components.emptyFilter")}</p>}

    {done && <p className="componentDone" role="status"><Check size={14}/>{t("components.removed")}</p>}
    {finished.length > 0 && !updating && <p className="componentDone" role="status"><Check size={14}/>{t(doneMode === "install" ? "components.install.finished" : "components.update.finished", { names: finished.map(nameOf).join(", ") })}</p>}
    {error && <div className="componentError" role="alert"><p>{errorHint}</p><details><summary>{t("components.details")}</summary><pre>{error}</pre></details></div>}

    <div className="componentSelectionBar" data-open={chosen.length > 0} inert={!chosen.length}>
      <div><strong>{t("components.selected", { count: chosen.length })}</strong><span>{formatSize(chosenBytes)} {t("components.willFree")}</span></div>
      <Button disabled={busy} onClick={() => setSelected([])}>{t("components.clearSelection")}</Button>
      <Button className="danger" disabled={!chosen.length || locked} onClick={() => setConfirm("modules")}><Trash2 size={14}/>{busy ? t("components.removing") : t("components.removeSelected", { count: chosen.length })}</Button>
    </div>

    <section className="componentAppRemoval">
      <span className="componentIcon isDanger" aria-hidden="true"><Trash2 size={18}/></span>
      <div><h4>{t("components.appRemoval")}</h4><p>{state?.uninstallerPath ? t("components.installedHelp") : t("components.portableHelp")}</p>
        <div className="componentAppActions"><Button className="danger" disabled={!state?.uninstallerPath || busy || loading} onClick={() => setConfirm("app")}><Trash2 size={14}/>{t("components.uninstallApp")}</Button>
          <Button disabled={!desktop || busy} onClick={() => void openUninstallSettings().catch(reason => setError(String(reason)))}><ExternalLink size={14}/>{t("components.windowsApps")}</Button></div>
      </div>
    </section>

    {confirm && createPortal(<dialog ref={dialog} className="modalCard componentRemovalDialog" aria-labelledby={dialogTitle} aria-describedby={dialogText} onCancel={event => { event.preventDefault(); if (!busy) setConfirm(null); }} onMouseDown={event => {
        if (busy || event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setConfirm(null);
      }} onKeyDown={event => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); setConfirm(null); }
        if (event.key === "Tab") {
          const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
          if (!buttons?.length) { event.preventDefault(); return; }
          const first = buttons[0]; const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
        <header><h2 id={dialogTitle}>{confirm === "app" ? t("components.uninstallApp") : t("components.confirmTitle")}</h2><Button disabled={busy} aria-label={t("actions.close")} onClick={() => setConfirm(null)}><X size={16}/></Button></header>
        <p id={dialogText}>{confirm === "app" ? t("components.confirmApp") : t("components.confirmText")}</p>
        {confirm === "modules" && <ul>{chosen.map(module => <li key={module.id}><ComponentIcon id={module.id} size={15}/><span>{titleFor(module.id, module.name)}</span><b>{formatSize(module.bytes)}</b></li>)}</ul>}
        <footer><button ref={cancelButton} className="uiButton" disabled={busy} onClick={() => setConfirm(null)}>{t("actions.cancel")}</button><Button className="danger" disabled={busy} onClick={() => void perform()}>{busy ? t("components.removing") : confirm === "app" ? t("components.openUninstaller") : t("components.confirmRemove")}</Button></footer>
    </dialog>, document.body)}
  </Panel>;
}
