import { Cpu, Activity, Boxes, Gauge, Pin, PinOff, ScrollText, Settings, SlidersHorizontal } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../store/control";
import { useStudioCopy } from "./ui/studioCopy";
import type { AppView } from "../types/app";
import { version as appVersion } from "../../package.json";

const nav: [AppView, React.ComponentType<{ size?: number }>, string][] = [
  ["dashboard", Gauge, "nav.dashboard"],
  ["configuration", SlidersHorizontal, "nav.configuration"],
  ["models", Boxes, "nav.library"],
  ["performance", Activity, "nav.benchmarks"],
  ["logs", ScrollText, "nav.logs"],
  ["settings", Settings, "nav.settings"],
];

export function Sidebar({ pinned, expanded, onTogglePin, onHoverChange }: { pinned: boolean; expanded: boolean; onTogglePin: () => void; onHoverChange: (hovered: boolean) => void }) {
  const { t } = useTranslation();
  const copy = useStudioCopy();
  const { activeView, setView, runtime, settings, updateSettings } = useControlStore();
  const engineName = settings.serverEngine === "qwfnfer" ? "QwFNfer" : settings.serverEngine === "ollama" ? "Ollama" : settings.serverEngine === "strata" ? "Strata" : "llama.cpp";
  const demoMode = !isTauri();

  return (
    <aside className={`sidebar${expanded ? " isExpanded" : " isCollapsed"}`} onPointerEnter={() => onHoverChange(true)} onPointerLeave={() => onHoverChange(false)} onFocusCapture={() => onHoverChange(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoverChange(false); }}>
      <div className="brand">
        <div className="llamaMark"><LlamaMark /></div>
        <div className="brandName"><strong>Aplot</strong><span>Control LLM</span></div>
        <button type="button" className="sidebarPin" aria-label={t(pinned ? "nav.unpinSidebar" : "nav.pinSidebar")} title={t(pinned ? "nav.unpinSidebar" : "nav.pinSidebar")} aria-pressed={pinned} onClick={onTogglePin}>{pinned ? <PinOff size={16}/> : <Pin size={16}/>}</button>
      </div>
      {demoMode && <div className="sidebarDemo"><span className="badge badge-orange">{t("app.demoMode")}</span></div>}
      <div className="navGroupLabel">{copy.navigation}</div>
      <nav aria-label={t("nav.primary")}>
        {nav.map(([id, Icon, key]) => {
          const selected = activeView === id || (id === "models" && activeView === "profiles");
          return <button key={id} className={selected ? "navItem active" : "navItem"} title={t(key)} aria-label={t(key)} onClick={() => setView(id)} aria-current={selected ? "page" : undefined}>
            <Icon size={18} /><span>{t(key)}</span>{selected && <i className="navActiveDot"/>}
          </button>;
        })}
      </nav>
      <div className="sidebarBottom">
        <div className="engineStatus">
          <div className="engineIdentity"><span className="engineIcon"><Cpu size={18}/></span><div><small>{copy.engine}</small><b>{engineName}</b></div></div>
          <span className={["stopped", "crashed"].includes(runtime.state) ? "detect offline" : "detect"}>● {t(`status.${runtime.state}`)}</span>
        </div>
        <div className="languageSwitcher" role="group" aria-label={t("settings.language")}>
          <button className={settings.language === "ru" ? "active" : ""} aria-pressed={settings.language === "ru"} onClick={() => void updateSettings({ language: "ru" })}>RU</button>
          <button className={settings.language === "en" ? "active" : ""} aria-pressed={settings.language === "en"} onClick={() => void updateSettings({ language: "en" })}>EN</button>
        </div>
        <div className="appVersionCard"><strong>v{appVersion}</strong></div>
      </div>
    </aside>
  );
}

function LlamaMark() {
  return <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M12 34V20L7.5 6.5l6.2 5.2 4 8.3h4l4.2-8.2 6.4-5.3L29 20c4 2.6 5 8.2 1.5 11.6L25 34H12Z"/><circle cx="25.7" cy="25.5" r="1.2"/></svg>;
}
