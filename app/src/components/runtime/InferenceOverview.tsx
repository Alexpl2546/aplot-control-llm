import { useTranslation } from "react-i18next";
import type { DashboardWidgetId } from "../../types/app";
import { useControlStore } from "../../store/control";
import { Panel, Progress } from "../ui/Primitives";
import { LiveSparkline } from "./LiveSparkline";
import { serverContextSize } from "../../lib/serverContext";

type MetricTone = "green" | "blue" | "orange" | "violet" | "muted";

function Metric({ label, value, values, timestamps, tone, help, unit, fractionDigits, subtitle, secondaryValues }: { label: string; value: string; values: number[]; timestamps: number[]; tone: MetricTone; help?: string; unit?: string; fractionDigits: number; subtitle?: string; secondaryValues?: (number | null | undefined)[] }) {
  const { t } = useTranslation();
  return <Panel className="metricTile"><span title={help}>{label}</span><strong>{value}</strong>{subtitle && <small className="metricSecondary" title={help}>{subtitle}</small>}{help === t("metrics.lastSample") && <small className="subtle">{help}</small>}<LiveSparkline values={values} timestamps={timestamps} tone={tone} label={label} unit={unit} fractionDigits={fractionDigits} secondaryValues={secondaryValues} secondaryLabel={t("metrics.generationMean")}/></Panel>;
}

export function InferenceOverview({ widget, rangeMinutes = 5 }: { widget: DashboardWidgetId; rangeMinutes?: number }) {
  const { t, i18n } = useTranslation();
  const runtime = useControlStore(state => state.runtime);
  const history = useControlStore(state => state.history);
  const chartHistory = history.filter(point => point.timestamp >= Date.now() - rangeMinutes * 60_000);
  const config = useControlStore(state => state.config);
  const settings = useControlStore(state => state.settings);
  const strataModels = useControlStore(state => state.strataModels);
  const runningConfig = useControlStore(state => state.runningConfig);
  const runningEngine = useControlStore(state => state.runningEngine);
  const engine = useControlStore(state => state.runningEngine ?? state.settings.serverEngine);
  const unsupported = engine === "ollama";
  const contextTotal = serverContextSize({ runtime, config, settings, strataModels, runningConfig, runningEngine });
  const recent = history.filter(point => point.timestamp >= Date.now() - 120_000);
  const lastGeneration = [...recent].reverse().find(point => point.generationTps > 0)?.generationTps ?? 0;
  const lastPrompt = [...recent].reverse().find(point => point.promptTps > 0)?.promptTps ?? 0;
  const live = ["ready", "busy"].includes(runtime.state);
  const generation = runtime.generationTps || (live ? lastGeneration : 0);
  const prompt = runtime.promptTps || (live ? lastPrompt : 0);
  const pct = contextTotal ? runtime.contextUsed / contextTotal * 100 : 0;
  const contextMax = Math.max(16_384, Math.ceil(contextTotal / 16_384) * 16_384);
  const contextLabel = (value: number) => value >= 1024 ? `${Math.round(value / 1024)}K` : String(value);

  if (unsupported && widget === "inference.context") return <Panel className="contextPanel"><div className="cardTitle">{t("context.title")}</div><strong>— / {contextTotal.toLocaleString(i18n.language)}</strong><p className="subtle">{t("metrics.ollamaPerRequest")}</p></Panel>;
  if (unsupported && widget === "inference.slots") return <Panel className="slotsPanel"><div className="cardTitle">{t("slots.title")}</div><p className="subtle">{t("metrics.ollamaPerRequest")}</p></Panel>;
  if (widget === "inference.context") return <Panel className="contextPanel">
    <div className="cardTitle" title={t("context.help")}>{t("context.title")}</div>
    <strong>{runtime.contextUsed.toLocaleString(i18n.language)} <em>/ {contextTotal.toLocaleString(i18n.language)} ({Math.round(pct)}%)</em></strong>
    <p className="subtle contextHelp">{t("context.help")}</p>
    <Progress value={pct}/>
    <div className="axis">{[0, 1, 2, 3, 4].map(index => <span key={index}>{contextLabel(contextMax * index / 4)}</span>)}</div>
  </Panel>;

  if (widget === "inference.slots") return <Panel className="slotsPanel">
    <div className="cardTitle">{t("slots.title")} ({runtime.slots.length})</div>
    <p className="subtle slotHelp">{t("slots.help")}</p>
    <div className="slotsList">{runtime.slots.length ? runtime.slots.map(slot => {
      const used = slot.contextTotal ? slot.contextUsed / slot.contextTotal * 100 : 0;
      return <div className="slotCard" key={`${slot.modelId ?? ""}:${slot.id}`}>
        <div><b title={t("slots.engineId", { id: slot.id })}>{t("slots.name", { number: slot.id + 1 })}</b>{slot.modelId && <span className="subtle slotModel">{slot.modelId}</span>}<span className={`slotState ${slot.state}`}>● {t(`slot.${slot.state}`)}</span></div>
        <p><span>{slot.contextUsed ? `${slot.contextUsed.toLocaleString(i18n.language)} ctx` : "—"}</span><span>{slot.generationTps ? `${slot.generationTps.toFixed(1)} tok/s` : "—"}</span></p>
        <Progress value={used}/>
      </div>;
    }) : <span className="subtle">{t("slots.none")}</span>}</div>
  </Panel>;

  const metrics: { id: DashboardWidgetId; label: string; value: string; tone: MetricTone; values: number[]; help?: string }[] = [
    { id: "inference.generation", label: t("metrics.generation"), value: `${generation.toFixed(1)} tok/s`, tone: "green", help: !runtime.generationTps && generation ? t("metrics.lastSample") : undefined, values: chartHistory.map(point => point.generationTps) },
    { id: "inference.prompt", label: t("metrics.prompt"), value: `${prompt.toFixed(1)} tok/s`, tone: "blue", help: !runtime.promptTps && prompt ? t("metrics.lastSample") : undefined, values: chartHistory.map(point => point.promptTps) },
    { id: "inference.activeRequests", label: t("metrics.activeRequests"), value: String(runtime.activeRequests), tone: "orange", values: chartHistory.map(point => point.activeRequests) },
    { id: "inference.queuedRequests", label: t("metrics.queuedRequests"), value: String(runtime.queuedRequests), tone: "muted", values: chartHistory.map(point => point.queuedRequests) },
    { id: "inference.ttft", label: t("metrics.ttft"), value: runtime.ttftMs != null ? `${runtime.ttftMs} ms` : "—", tone: "violet", values: chartHistory.map(point => point.ttftMs ?? Number.NaN), help: t("metrics.ttftHelp") },
  ];
  const metric = metrics.find(item => item.id === widget);
  const strataGeneration = engine === "strata" && widget === "inference.generation";
  const mean = runtime.generationMeanTps;
  return metric ? <Metric label={strataGeneration && runtime.generationWindowSeconds != null ? t("metrics.generationWindow", { seconds: runtime.generationWindowSeconds }) : metric.label} value={unsupported ? "—" : metric.value} values={unsupported ? [] : metric.values} timestamps={unsupported ? [] : chartHistory.map(point => point.timestamp)} tone={metric.tone} help={unsupported ? t("metrics.ollamaPerRequest") : strataGeneration ? t("metrics.generationRateHelp") : metric.help} unit={widget === "inference.ttft" ? "ms" : ["inference.generation", "inference.prompt"].includes(widget) ? "tok/s" : undefined} fractionDigits={["inference.generation", "inference.prompt"].includes(widget) ? 1 : 0} subtitle={strataGeneration && mean != null ? `${t("metrics.generationMean")}: ${mean.toLocaleString(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} tok/s` : undefined} secondaryValues={strataGeneration ? chartHistory.map(point => point.generationMeanTps) : undefined}/> : null;
}
