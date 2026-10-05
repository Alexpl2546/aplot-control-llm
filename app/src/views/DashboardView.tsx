import { Activity, Check, Minus, Move, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HardwareOverview } from "../components/runtime/HardwareOverview";
import { InferenceOverview } from "../components/runtime/InferenceOverview";
import { ServerHeader } from "../components/runtime/ServerHeader";
import { DashboardCharts } from "../components/runtime/DashboardCharts";
import { DashboardCanvas } from "../components/runtime/DashboardCanvas";
import { DEFAULT_DASHBOARD_WIDGETS, normalizeDashboardWidgets, type DashboardLayout, type DashboardWidgetId } from "../types/app";
import { useControlStore } from "../store/control";
import { isTauri } from "@tauri-apps/api/core";
import { useStudioCopy } from "../components/ui/studioCopy";
import { Panel } from "../components/ui/Primitives";

const widgetGroups = [
  {
    id: "hardware",
    labelKey: "dashboard.widget.hardware",
    items: [
      { id: "hardware.gpu", labelKey: "dashboard.card.gpu" },
      { id: "hardware.cpu", labelKey: "dashboard.card.cpu" },
      { id: "hardware.memory", labelKey: "dashboard.card.memory" },
    ],
  },
  {
    id: "inference",
    labelKey: "dashboard.widget.inference",
    items: [
      { id: "inference.generation", labelKey: "dashboard.card.generation" },
      { id: "inference.prompt", labelKey: "dashboard.card.prompt" },
      { id: "inference.activeRequests", labelKey: "dashboard.card.activeRequests" },
      { id: "inference.queuedRequests", labelKey: "dashboard.card.queuedRequests" },
      { id: "inference.ttft", labelKey: "dashboard.card.ttft" },
      { id: "inference.context", labelKey: "dashboard.card.context" },
      { id: "inference.slots", labelKey: "dashboard.card.slots" },
    ],
  },
  {
    id: "charts",
    labelKey: "dashboard.widget.charts",
    items: [
      { id: "charts.throughput", labelKey: "dashboard.card.chartThroughput" },
      { id: "charts.hardware", labelKey: "dashboard.card.chartHardware" },
      { id: "charts.memory", labelKey: "dashboard.card.chartMemory" },
      { id: "charts.thermals", labelKey: "dashboard.card.chartThermals" },
      { id: "charts.requests", labelKey: "dashboard.card.chartRequests" },
    ],
  },
] as const satisfies readonly {
  id: string;
  labelKey: string;
  items: readonly { id: DashboardWidgetId; labelKey: string }[];
}[];

const widgetLabelKeys = Object.fromEntries(widgetGroups.flatMap(group => group.items.map(item => [item.id, item.labelKey]))) as Record<DashboardWidgetId, string>;
const intervals = [
  { minutes: 1, key: "performance.interval1m" },
  { minutes: 5, key: "performance.interval5m" },
  { minutes: 15, key: "performance.interval15m" },
  { minutes: 60, key: "performance.interval1h" },
] as const;

export function DashboardView() {
  const { t, i18n } = useTranslation();
  const copy = useStudioCopy();
  const settings = useControlStore(state => state.settings);
  const updateSettings = useControlStore(state => state.updateSettings);
  const notify = useControlStore(state => state.notify);
  const history = useControlStore(state => state.history);
  const [savingWidgets, setSavingWidgets] = useState(false);
  const [editingLayout, setEditingLayout] = useState(false);
  const [draftLayout, setDraftLayout] = useState<DashboardLayout | null>(null);
  const [chartRangeMinutes, setChartRangeMinutes] = useState(5);
  const widgets = useMemo(() => normalizeDashboardWidgets(settings.dashboardWidgets), [settings.dashboardWidgets]);
  const selectedWidgets = useMemo(() => new Set<DashboardWidgetId>(widgets), [widgets]);
  const has = (name: DashboardWidgetId) => selectedWidgets.has(name);
  const showCharts = widgets.some(widget => widget.startsWith("charts."));
  const chartData = useMemo(() => {
    const cutoff = Date.now() - chartRangeMinutes * 60_000;
    return history.filter(point => point.timestamp >= cutoff).map(point => ({
      ...point,
      time: new Date(point.timestamp).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    }));
  }, [history, i18n.language, chartRangeMinutes]);

  const saveWidgets = async (next: readonly string[]) => {
    setSavingWidgets(true);
    try {
      await updateSettings({ dashboardWidgets: normalizeDashboardWidgets(next) });
    } catch (error) {
      notify("error", String(error));
    } finally {
      setSavingWidgets(false);
    }
  };

  const toggleWidget = (id: DashboardWidgetId) => {
    const next = has(id) ? widgets.filter(widget => widget !== id) : [...widgets, id];
    void saveWidgets(next);
  };

  const toggleGroup = (ids: readonly DashboardWidgetId[]) => {
    const allSelected = ids.every(id => has(id));
    const next = allSelected ? widgets.filter(widget => !ids.includes(widget)) : [...widgets, ...ids.filter(id => !has(id))];
    void saveWidgets(next);
  };

  const saveLayout = async () => {
    setSavingWidgets(true);
    try { await updateSettings({ dashboardLayout: draftLayout }); setEditingLayout(false); }
    catch (error) { notify("error", String(error)); }
    finally { setSavingWidgets(false); }
  };
  const resetLayout = async () => {
    if (editingLayout) { setDraftLayout(null); return; }
    setSavingWidgets(true);
    try { await updateSettings({ dashboardLayout: null }); }
    catch (error) { notify("error", String(error)); }
    finally { setSavingWidgets(false); }
  };

  const renderWidget = (widget: DashboardWidgetId) => {
    if (widget.startsWith("hardware.")) return <HardwareOverview widget={widget}/>;
    if (widget.startsWith("inference.")) return <InferenceOverview widget={widget} rangeMinutes={chartRangeMinutes}/>;
    return <DashboardCharts widget={widget} data={chartData}/>;
  };

  return <div className="dashboardPage">
    <div className="dashboardHeading">
      <div><div className="pageEyebrow"><span/> APLOT CONTROL <span className="eyebrowDivider">/</span> {copy.monitoring}</div><h1>{copy.overview}</h1></div>
      <details className="dashboardCustomize">
        <summary className="dashboardCustomizeButton"><SlidersHorizontal size={15}/><span>{t("dashboard.customize")}</span><b>{widgets.length}</b></summary>
        <div className="dashboardWidgetMenu">
          <header className="dashboardWidgetMenuHeader">
            <div><strong>{t("dashboard.widgetMenuTitle")}</strong><small>{t("dashboard.widgetMenuCount", { selected: widgets.length, total: DEFAULT_DASHBOARD_WIDGETS.length })}</small></div>
            <button type="button" disabled={savingWidgets || widgets.length === DEFAULT_DASHBOARD_WIDGETS.length} onClick={() => void saveWidgets(DEFAULT_DASHBOARD_WIDGETS)}><RotateCcw size={13}/>{t("dashboard.restoreDefaults")}</button>
          </header>
          <div className="dashboardWidgetGroups">
            {widgetGroups.map(group => {
              const ids = group.items.map(item => item.id);
              const selectedCount = ids.filter(id => has(id)).length;
              const allSelected = selectedCount === ids.length;
              return <section className="dashboardWidgetGroup" key={group.id}>
                <button type="button" className="dashboardWidgetGroupToggle" disabled={savingWidgets} aria-pressed={allSelected} onClick={() => toggleGroup(ids)}>
                  <span className={`dashboardWidgetCheck${allSelected ? " selected" : selectedCount ? " mixed" : ""}`}>{allSelected ? <Check size={12}/> : selectedCount ? <Minus size={12}/> : null}</span>
                  <strong>{t(group.labelKey)}</strong><small>{selectedCount}/{ids.length}</small>
                </button>
                <div className="dashboardWidgetOptions">
                  {group.items.map(item => <button type="button" key={item.id} disabled={savingWidgets} aria-pressed={has(item.id)} onClick={() => toggleWidget(item.id)}>
                    <span className={`dashboardWidgetCheck${has(item.id) ? " selected" : ""}`}>{has(item.id) ? <Check size={12}/> : null}</span>{t(item.labelKey)}
                  </button>)}
                </div>
              </section>;
            })}
          </div>
        </div>
      </details>
    </div>
    <div className="dashboardLayout">
      <div className="dashboardMain">
        <ServerHeader/>
        {showCharts && <div className="dashboardChartToolbar"><div className="telemetryHeading"><h2>{t("dashboard.liveCharts")}</h2><span><Activity size={12}/>{isTauri() ? copy.live : copy.demo}</span></div><div className="rangeToolbar" role="group" aria-label={t("performance.interval")}>
          {intervals.map(interval => <button type="button" key={interval.minutes} className={chartRangeMinutes === interval.minutes ? "active" : ""} aria-pressed={chartRangeMinutes === interval.minutes} onClick={() => setChartRangeMinutes(interval.minutes)}>{t(interval.key)}</button>)}
        </div></div>}
        {widgets.length > 0 && <div className="dashboardLayoutActions">
          {editingLayout ? <>
            <button type="button" className="primary" disabled={savingWidgets} onClick={() => void saveLayout()}><Check size={14}/>{t("dashboard.saveLayout")}</button>
            <button type="button" disabled={savingWidgets} onClick={() => { setEditingLayout(false); setDraftLayout(null); }}>{t("actions.cancel")}</button>
            <button type="button" disabled={savingWidgets} onClick={() => void resetLayout()}><RotateCcw size={14}/>{t("dashboard.resetLayout")}</button>
            <p className="dashboardLayoutHint">{t("dashboard.layoutHelp")}</p>
          </> : <>
            <button type="button" disabled={savingWidgets} onClick={() => { setDraftLayout(settings.dashboardLayout); setEditingLayout(true); }}><Move size={14}/>{t("dashboard.editLayout")}</button>
            {settings.dashboardLayout && <button type="button" disabled={savingWidgets} onClick={() => void resetLayout()}><RotateCcw size={14}/>{t("dashboard.resetLayout")}</button>}
          </>}
        </div>}
        <DashboardCanvas widgets={widgets} layout={editingLayout ? draftLayout : settings.dashboardLayout} editing={editingLayout} disabled={savingWidgets} onChange={setDraftLayout} label={id => t(widgetLabelKeys[id])} renderWidget={renderWidget}/>
        {!widgets.length && <Panel className="dashboardNoTiles"><p>{t("dashboard.noTiles")}</p><button type="button" onClick={() => void saveWidgets(DEFAULT_DASHBOARD_WIDGETS)}>{t("dashboard.restoreDefaults")}</button></Panel>}
      </div>
    </div>
  </div>;
}
