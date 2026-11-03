import { Search } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { NotificationCenter } from "../feedback/NotificationCenter";
import { usePalette } from "./CommandPalette";
import { WindowControls } from "./WindowControls";

export function KTopbar() {
  const { t } = useTranslation();
  return <header className="kTopbar" data-tauri-drag-region>
    <div className="kTopRun" data-tauri-drag-region/>
    <button type="button" className="kCommand" data-key-hint="Ctrl K" onClick={() => usePalette.getState().setOpen(true)}><Search size={14}/><span>{t("palette.open")}</span><kbd>Ctrl K</kbd></button>
    <NotificationCenter/>
    {!isTauri() && <span className="kDemo" title={t("k.demo.title")}>{t("k.demo")}</span>}
    <WindowControls/>
  </header>;
}
