import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink, FolderOpen, RefreshCw, Trash2, X } from "lucide-react";
import { Button, Panel } from "../ui/Primitives";
import { getComponentMaintenance, isRemovedComponentPath, launchUninstaller, openUninstallSettings, removeInstalledComponents, type ComponentMaintenanceState, type InstalledModule } from "../../services/components";
import { revealItem } from "../../services/desktop";
import { useControlStore } from "../../store/control";
import { isTauri } from "@tauri-apps/api/core";
import "./ComponentManager.css";

export function ComponentManager() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<ComponentMaintenanceState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [confirm, setConfirm] = useState<"modules" | "app" | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialogTitle = useId();
  const dialogText = useId();
  const desktop = isTauri();
  const titleFor = (module: InstalledModule) => module.id === "cache" ? t("components.cache") : module.id === "python_runtime" ? t("components.python") : module.name;
  const formatSize = (bytes: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 }).format(bytes / 1024 ** 2) + " MB";
  const modules = state?.modules ?? [];
  const chosen = modules.filter(module => selected.includes(module.id));
  const pythonNeeded = modules.some(module => ["strata", "hermes"].includes(module.id) && module.paths.length > 0 && !selected.includes(module.id));

  useEffect(() => {
    mounted.current = true;
    void getComponentMaintenance().then(value => { if (mounted.current) setState(value); })
      .catch(reason => { if (mounted.current) setError(String(reason)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    cancelButton.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, [confirm]);
  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const next = await getComponentMaintenance();
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
  const errorHint = error.includes("process-active") ? t("components.active")
    : error.includes("python-in-use") ? t("components.pythonNeeded")
    : error.includes("maintenance-busy") ? t("components.locked")
    : error.includes("link-protected") ? t("components.links") : t("components.failed");
  const renderModule = (module: InstalledModule) => {
    const present = module.paths.length > 0;
    const disabled = !present || !!module.blocked || busy || loading || (module.id === "python_runtime" && pythonNeeded);
    return <div className="componentRow" key={module.id}>
      <label className="componentChoice">
        <input type="checkbox" checked={selected.includes(module.id)} disabled={disabled} onChange={event => {
          setDone(false);
          setSelected(previous => {
            const next = event.target.checked ? [...previous, module.id] : previous.filter(id => id !== module.id);
            return !event.target.checked && ["strata", "hermes"].includes(module.id) ? next.filter(id => id !== "python_runtime") : next;
          });
        }}/>
        <span><strong>{titleFor(module)}</strong><small>{present ? module.versions.join(", ") || t("components.shared") : module.externalPath ? t("components.external") : t("components.absent")}</small></span>
        {present && <span className="componentSize">{formatSize(module.bytes)}</span>}
      </label>
      {module.id === "python_runtime" && present && pythonNeeded && <p className="subtle componentHint">{t("components.pythonNeeded")}</p>}
      {module.blocked && <p className="subtle componentHint">{t("components.links")}</p>}
      {(present || module.externalPath) && <details className="componentPaths"><summary>{t("components.locations")}</summary>
        {module.paths.map(path => <div key={path}><code>{path}</code><Button disabled={busy} aria-label={t("components.showFolder")} onClick={() => void revealItem(path).catch(reason => setError(String(reason)))}><FolderOpen size={14}/></Button></div>)}
        {module.externalPath && <div><span><small>{t("components.external")}</small><code>{module.externalPath}</code></span><Button disabled={busy} aria-label={t("components.showFolder")} onClick={() => void revealItem(module.externalPath!).catch(reason => setError(String(reason)))}><FolderOpen size={14}/></Button></div>}
      </details>}
    </div>;
  };
  return <Panel className="settingsSection componentManager">
    <header className="componentHeader"><h3>{t("components.title")}</h3><Button disabled={busy || loading} aria-label={t("components.refresh")} onClick={() => void refresh()}><RefreshCw size={14}/></Button></header>
    <p className="subtle">{t("components.description")}</p>
    {loading && <p role="status">{t("components.loading")}</p>}
    {!desktop && <p className="subtle">{t("components.desktopOnly")}</p>}
    {modules.filter(module => !["cache", "python_runtime"].includes(module.id)).map(renderModule)}
    {modules.some(module => ["cache", "python_runtime"].includes(module.id) && module.paths.length > 0) && <div className="componentShared"><h4>{t("components.sharedTitle")}</h4>{modules.filter(module => ["cache", "python_runtime"].includes(module.id) && module.paths.length > 0).map(renderModule)}</div>}
    {done && <p role="status">{t("components.removed")}</p>}
    {error && <div className="componentError" role="alert"><p>{errorHint}</p><details><summary>{t("components.details")}</summary><pre>{error}</pre></details></div>}
    <div className="settingsActions"><Button className="danger" disabled={!chosen.length || busy || loading} onClick={() => setConfirm("modules")}><Trash2 size={14}/>{busy ? t("components.removing") : t("components.removeSelected", { count: chosen.length })}</Button><span className="subtle">{chosen.length > 0 && formatSize(chosen.reduce((sum, module) => sum + module.bytes, 0))}</span></div>
    <div className="componentAppRemoval"><h4>{t("components.appRemoval")}</h4>
      <p className="subtle">{state?.uninstallerPath ? t("components.installedHelp") : t("components.portableHelp")}</p>
      <div className="settingsActions"><Button disabled={!state?.uninstallerPath || busy || loading} onClick={() => setConfirm("app")}><Trash2 size={14}/>{t("components.uninstallApp")}</Button>
        <Button disabled={!desktop || busy} onClick={() => void openUninstallSettings().catch(reason => setError(String(reason)))}><ExternalLink size={14}/>{t("components.windowsApps")}</Button></div>
    </div>
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
        {confirm === "modules" && <ul>{chosen.map(module => <li key={module.id}>{titleFor(module)} · {formatSize(module.bytes)}</li>)}</ul>}
        <footer><button ref={cancelButton} className="uiButton" disabled={busy} onClick={() => setConfirm(null)}>{t("actions.cancel")}</button><Button className="danger" disabled={busy} onClick={() => void perform()}>{busy ? t("components.removing") : confirm === "app" ? t("components.openUninstaller") : t("components.confirmRemove")}</Button></footer>
    </dialog>, document.body)}
  </Panel>;
}
