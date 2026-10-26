import { SidebarAgents } from './SidebarAgents';
import { CodexQuota } from '../../features/openai/CodexQuota';
import { Activity, Bot, Boxes, Gauge, Moon, Pin, PinOff, Plug, Plus, ScrollText, Settings, SlidersHorizontal, Sun, MessageSquare } from "lucide-react";
import { useCallback, useState, type ComponentType, type MouseEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { ENGINE_NAMES } from "../../lib/engineModels";
import type { AppView } from "../../types/app";
import { isActive, isTransition, isWorking, portOf, runColor, type RunPresentation } from "../../features/launches/presentation";
import { formatGb, MemoryTrack } from "./MemoryTrack";
import { useMemoryModels, useRunCounts } from "./useShellData";
import { version as appVersion } from "../../../package.json";
import { ServerActionsMenu, type ServerMenuTarget } from '../../features/launches/ServerActionsMenu';
import { QuickServerDialog } from '../../features/launches/QuickServerDialog';
import { useLaunchUi } from '../../features/launches/ui';
import { languageName, nextAppLanguage } from "../../lib/languages";
import { prefetchView } from '../../lib/viewModules';

const NAV: [AppView, ComponentType<{ size?: number }>, string][] = [
  ["dashboard", Gauge, "nav.dashboard"],
  ["chat", MessageSquare, "chat.title"],
  ["agentWorkspace", Bot, "desk.workspace"],
  ["configuration", SlidersHorizontal, "nav.configuration"],
  ["models", Boxes, "nav.library"],
  ["performance", Activity, "nav.benchmarks"],
  ["logs", ScrollText, "nav.logs"],
  ["apiDocs", Plug, "k.nav.api"],
];

function ServerRow({ run, index, selected, onSelect, onMenu }: { run: RunPresentation; index: number; selected: boolean; onSelect: () => void; onMenu:(event:MouseEvent|KeyboardEvent)=>void }) {
  const { t, i18n } = useTranslation();
  const { state } = run.info;
  const pinned=useControlStore(s=>(s.settings.pinnedServerIds??[]).includes(run.info.runId));
  const tps = run.runtime.generationTps;
  const port = portOf(run.info.endpoint);
  const trailing = state === "crashed" ? <span className="kChip isDanger">{t("status.crashed")}</span>
    : isTransition(state) ? <span className="kChip isInfo">{t(`status.${state}`)}</span>
      : isWorking(state) && tps > 0 ? <b className="kMono">{tps.toLocaleString(i18n.language, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}</b>
        : <span className="kMuted">—</span>;
  return <button type="button" className={`kRun${selected ? " isSelected" : ""}`} style={{ ["--c" as string]: runColor(run.info.runId) }} onClick={onSelect} aria-current={selected ? "true" : undefined}
    onContextMenu={onMenu} onKeyDown={event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)onMenu(event);}}
    title={`${run.info.name} · ${ENGINE_NAMES[run.info.engine]} · ${t(`status.${state}`)}`}>
    <span className={`kLed is-${state}`} aria-hidden="true"/>
    <span className="kRunText"><b>{pinned&&<Pin size={11} aria-label={t("desk.server.pinned")}/>} {run.info.name}</b><small><i className="kRunCh">{t("k.serverNumber", { number: index + 1 })}</i> · {ENGINE_NAMES[run.info.engine]}{port && ` · :${port}`}</small></span>
    <span className="kRunTrail">{trailing}</span>
    <span className="kRailCh" aria-hidden="true">S{index + 1}</span>
  </button>;
}

export function KSidebar({ pinned, expanded, onTogglePin, onHoverChange, onFocusChange }: { pinned: boolean; expanded: boolean; onTogglePin: () => void; onHoverChange: (hovered: boolean) => void; onFocusChange: (focused: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const { activeView, setView, runs, selectedRunId, selectRun, settings, updateSettings, runtime } = useControlStore();
  const [menu,setMenu]=useState<ServerMenuTarget>();
  const closeMenu=useCallback(()=>setMenu(undefined),[]);
  const memory = useMemoryModels();
  const counts = useRunCounts();
  const dark = settings.theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : settings.theme === "dark";
  const indexed = runs.map((run, index) => ({ run, index }));
  const groups = runs.length > 4
    ? [
      ["k.group.attention", indexed.filter(({ run }) => run.info.state === "crashed")],
      ["k.group.live", indexed.filter(({ run }) => isActive(run.info.state))],
      ["k.group.stopped", indexed.filter(({ run }) => run.info.state === "stopped")],
    ] as const
    : [["", indexed]] as const;
  const select = (runId: string) => { if (runId !== selectedRunId) selectRun(runId); };
  const meter = (label: string, model: typeof memory.vram) => <div className="kMeter">
    <div className="kMeterHead"><span>{label}</span><b className="kMono">{formatGb(model.measuredGib, i18n.language)} / {formatGb(model.totalGib, i18n.language)} {t("k.unit.gb")}</b></div>
    <MemoryTrack model={model} thin labels={false} selectedRunId={selectedRunId}/>
  </div>;

  return <aside className={`kSidebar${expanded ? "" : " isRail"}`} aria-label={t("nav.primary")} onPointerEnter={() => onHoverChange(true)} onPointerLeave={() => onHoverChange(false)} onFocusCapture={event => onFocusChange(event.target.matches(":focus-visible"))} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange(false); }}>
    <div className="kBrand">
      <span className="kLogo"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M12 34V20L7.5 6.5l6.2 5.2 4 8.3h4l4.2-8.2 6.4-5.3L29 20c4 2.6 5 8.2 1.5 11.6L25 34H12Z"/></svg></span>
      <span className="kBrandText"><b>Aplot Control</b><small>LLM · v{appVersion}</small></span>
      <button type="button" className="kIconBtn kPin" aria-label={t(pinned ? "nav.unpinSidebar" : "nav.pinSidebar")} title={t(pinned ? "nav.unpinSidebar" : "nav.pinSidebar")} aria-pressed={pinned} onClick={onTogglePin}>{pinned ? <PinOff size={15}/> : <Pin size={15}/>}</button>
    </div>
    <nav className="kNav" aria-label={t("nav.primary")}>
      {NAV.map(([id, Icon, key]) => {
        const selected = activeView === id || (id === "models" && activeView === "profiles");
        const shortcut = (["dashboard", "configuration", "models", "performance", "logs", "apiDocs"] as string[]).indexOf(id);
        return <button key={id} type="button" className={selected ? "isOn" : ""} aria-current={selected ? "page" : undefined} title={`${t(key)}${shortcut >= 0 ? ` · Ctrl ${shortcut + 1}` : ''}`} onPointerEnter={() => prefetchView(id)} onFocus={() => prefetchView(id)} onClick={() => setView(id)}>
          <Icon size={17}/><span className="kNavLabel">{t(key)}</span>
          {id === "logs" && counts.crashed > 0 && <i className="kDot" aria-hidden="true"/>}
        </button>;
      })}
    </nav>
    <div className="deskSideProcesses"><div className="kServers">
      <div className="kServersHead"><span>{t("k.servers")}</span><span className="kMono">{t("k.servers.count", { active: counts.active, total: counts.total })}</span>
        <button type="button" className="kIconBtn" title={t("k.servers.new")} aria-label={t("k.servers.new")} onClick={() => useLaunchUi.getState().setQuickAdd(true)}><Plus size={14}/></button></div>
      <div className="kServerList">
        {!runs.length && <p className="kEmptyNote">{t("k.servers.empty")}</p>}
        {groups.map(([label, items]) => items.length > 0 && <div key={label || "all"} className="kServerGroup">
          {label && <div className="kGroupLabel"><span>{t(label)}</span><span className="kMono">{items.length}</span></div>}
          {items.map(({ run, index }) => <ServerRow key={run.info.runId} run={run} index={index} selected={run.info.runId === selectedRunId} onSelect={() => select(run.info.runId)} onMenu={event=>{event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();setMenu({runId:run.info.runId,x:'clientX' in event?event.clientX:rect.right,y:'clientY' in event?event.clientY:rect.top});}}/>)}
        </div>)}
      </div>
    </div>
    <SidebarAgents/></div>
    <div className="kSideFoot"><CodexQuota/>
      {meter("VRAM", memory.vram)}
      {meter("RAM", memory.ram)}
      <div className="kHw"><span>GPU <b className="kMono">{Math.round(runtime.gpu.utilization)}%</b></span><span>CPU <b className="kMono">{Math.round(runtime.cpu.utilization)}%</b></span><span><b className="kMono">{runtime.gpu.temperatureC} °C</b></span></div>
      <div className="kFootRow">
        <button type="button" className={`kFootBtn${useControlStore.getState().settingsOpen ? " isOn" : ""}`} onClick={() => setView("settings")} title={t("nav.settings")}><Settings size={16}/><span className="kNavLabel">{t("nav.settings")}</span></button>
        <button type="button" className="kIconBtn kLang" title={t("language.switchTo", { language: languageName(nextAppLanguage(settings.language)) })} aria-label={t("language.switchTo", { language: languageName(nextAppLanguage(settings.language)) })} onClick={() => void updateSettings({ language: nextAppLanguage(settings.language) })}>{settings.language.toUpperCase()}</button>
        <button type="button" className="kIconBtn" title={t(dark ? "k.theme.toLight" : "k.theme.toDark")} aria-label={t(dark ? "k.theme.toLight" : "k.theme.toDark")} onClick={() => void updateSettings({ theme: dark ? "light" : "dark" })}>{dark ? <Sun size={15}/> : <Moon size={15}/>}</button>
      </div>
    </div>
    <ServerActionsMenu target={menu} onClose={closeMenu}/><QuickServerDialog/>
  </aside>;
}
