import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "../../services/tauri";
import { mainWindow } from "../../services/desktop";

/**
 * In-app window buttons for the frameless main window (decorations are off in tauri.conf.json).
 * Drawn as thin line glyphs to match Windows proportions; close turns red on hover like the system button.
 * Closing goes through the normal close request, so "close to tray" keeps working.
 */
export function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const win = mainWindow();
    let off: (() => void) | undefined, disposed = false;
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => undefined);
    sync();
    void win.onResized(sync).then(unlisten => { if (disposed) unlisten(); else off = unlisten; });
    return () => { disposed = true; off?.(); };
  }, []);
  if (!isTauri()) return null;
  const win = mainWindow();
  const run = (action: () => Promise<unknown>) => () => void action().catch(console.error);
  return <div className="kWindowControls" role="group" aria-label={t("window.controls")}>
    <button type="button" aria-label={t("window.minimize")} title={t("window.minimize")} onClick={run(() => win.minimize())}>
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10"/></svg></button>
    <button type="button" aria-label={t(maximized ? "window.restore" : "window.maximize")} title={t(maximized ? "window.restore" : "window.maximize")} onClick={run(() => win.toggleMaximize())}>
      {maximized
        ? <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z"/></svg>
        : <svg viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" rx="1.2"/></svg>}</button>
    <button type="button" className="isClose" aria-label={t("window.close")} title={t("window.close")} onClick={run(() => win.close())}>
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9M9.5.5l-9 9"/></svg></button>
  </div>;
}
