import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RuntimeHistoryPoint } from "../../types/runtime";
import type { DashboardWidgetId } from "../../types/app";
import { Panel } from "../ui/Primitives";

const colors = { generation: "#45df81", prompt: "#56a8ff", ttft: "#a779ff", gpu: "#45df81", cpu: "#56a8ff", vram: "#a779ff", ram: "#f2b85b", temp: "#ff8b68", power: "#f2b85b", requests: "#56a8ff", queued: "#a779ff" };
const axisTick = { fill: "var(--muted)", fontSize: 11 };

export type DashboardChartPoint = RuntimeHistoryPoint & { time: string };

export function DashboardCharts({ widget, data }: { widget: DashboardWidgetId; data: DashboardChartPoint[] }) {
  const { t } = useTranslation();
  const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" };
  const axis = <><CartesianGrid stroke="var(--border)" vertical={false}/><XAxis dataKey="time" minTickGap={45} tick={axisTick}/><Tooltip contentStyle={tooltipStyle}/></>;

  if (widget === "charts.throughput") return <Panel className="chartCard"><h3>{t("performance.throughput")}</h3><ResponsiveContainer width="100%" height="100%" minHeight={140}><LineChart data={data}>{axis}<YAxis yAxisId="rate" width={46} tick={axisTick}/><YAxis yAxisId="latency" orientation="right" width={50} tick={axisTick}/><Line yAxisId="rate" type="monotone" dataKey="generationTps" name={t("metrics.generation")} dot={false} stroke={colors.generation}/>{data.some(point => point.generationMeanTps != null) && <Line yAxisId="rate" type="monotone" dataKey="generationMeanTps" name={t("metrics.generationMean")} dot={false} connectNulls={false} stroke={colors.generation} strokeDasharray="4 4"/>}<Line yAxisId="rate" type="monotone" dataKey="promptTps" name={t("metrics.prompt")} dot={false} stroke={colors.prompt}/><Line yAxisId="latency" type="monotone" dataKey="ttftMs" name={t("metrics.ttft")} dot={false} connectNulls={false} stroke={colors.ttft}/></LineChart></ResponsiveContainer></Panel>;

  if (widget === "charts.hardware") return <Panel className="chartCard"><h3>{t("performance.hardware")}</h3><ResponsiveContainer width="100%" height="100%" minHeight={140}><LineChart data={data}>{axis}<YAxis domain={[0, 100]} width={46} tick={axisTick}/><Line type="monotone" dataKey="gpu" name={t("metrics.gpu")} dot={false} stroke={colors.gpu}/><Line type="monotone" dataKey="cpu" name={t("metrics.cpu")} dot={false} stroke={colors.cpu}/></LineChart></ResponsiveContainer></Panel>;

  if (widget === "charts.memory") return <Panel className="chartCard"><h3>{t("metrics.vram")} / {t("metrics.memory")}</h3><ResponsiveContainer width="100%" height="100%" minHeight={140}><AreaChart data={data}>{axis}<YAxis width={54} tick={axisTick} tickFormatter={value => `${(value / 1024).toFixed(0)} GB`}/><Area type="monotone" dataKey="vramMiB" name={t("metrics.vram")} fillOpacity={.14} stroke={colors.vram} fill={colors.vram}/><Area type="monotone" dataKey="ramMiB" name={t("metrics.memory")} fillOpacity={.08} stroke={colors.ram} fill={colors.ram}/></AreaChart></ResponsiveContainer></Panel>;

  if (widget === "charts.thermals") return <Panel className="chartCard"><h3>{t("metrics.temperature")} / {t("metrics.power")}</h3><ResponsiveContainer width="100%" height="100%" minHeight={140}><LineChart data={data}>{axis}<YAxis yAxisId="temperature" width={46} tick={axisTick}/><YAxis yAxisId="power" orientation="right" width={50} tick={axisTick}/><Line yAxisId="temperature" type="monotone" dataKey="gpuTemperatureC" name={t("metrics.temperature")} dot={false} stroke={colors.temp}/><Line yAxisId="power" type="monotone" dataKey="gpuPowerW" name={t("metrics.power")} dot={false} stroke={colors.power}/></LineChart></ResponsiveContainer></Panel>;

  if (widget === "charts.requests") return <Panel className="chartCard"><h3>{t("metrics.activeRequests")} / {t("metrics.queuedRequests")}</h3><ResponsiveContainer width="100%" height="100%" minHeight={140}><AreaChart data={data}>{axis}<YAxis allowDecimals={false} width={46} tick={axisTick}/><Area type="stepAfter" dataKey="activeRequests" name={t("metrics.activeRequests")} fillOpacity={.15} stroke={colors.requests} fill={colors.requests}/><Area type="stepAfter" dataKey="queuedRequests" name={t("metrics.queuedRequests")} fillOpacity={.1} stroke={colors.queued} fill={colors.queued}/></AreaChart></ResponsiveContainer></Panel>;

  return null;
}
