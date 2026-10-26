import { useTranslation } from "react-i18next";
import { gib } from "../../lib/format";
import type { DashboardWidgetId } from "../../types/app";
import { useControlStore } from "../../store/control";
import { Panel, Progress } from "../ui/Primitives";
import { LiveSparkline } from "./LiveSparkline";
import { memoryHardwareSummary } from "../../lib/memoryHardware";
import { formatGpuWatts, gpuPowerLabel } from "../../lib/gpuPower";

function Gauge({ value, tone }: { value: number; tone: string }) {
  return <div className={`ringGauge ${tone}`} style={{ "--p": `${Math.max(0, Math.min(100, value)) * 3.6}deg` } as React.CSSProperties}><span>{Math.round(value)}%</span></div>;
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="kvRow" title={title}><span>{label}</span><b>{value}</b></div>;
}

export function HardwareOverview({ widget }: { widget: DashboardWidgetId }) {
  const { t, i18n } = useTranslation();
  const runtime = useControlStore(state => state.runtime);
  const history = useControlStore(state => state.history);
  const ramPercent = runtime.memory.totalMiB ? runtime.memory.usedMiB / runtime.memory.totalMiB * 100 : 0;
  const memoryHardware = memoryHardwareSummary(runtime.memory.modules);

  if (widget === "hardware.gpu") return <Panel className="hardwareCard gpuCard">
    <div className="cardTitle">GPU — <span className="greenText">{runtime.gpu.name}</span></div>
    <div className="hardwareBody"><Gauge value={runtime.gpu.utilization} tone="green"/><div className="hardwareRows">
      <Row label={t("metrics.vram")} value={`${gib(runtime.gpu.memoryUsedMiB)} / ${gib(runtime.gpu.memoryTotalMiB)} GB`}/>
      <Row label={t("metrics.temperature")} value={`${runtime.gpu.temperatureC} °C`}/>
      <Row label={t(gpuPowerLabel(runtime.gpu))} value={formatGpuWatts(runtime.gpu.powerW, i18n.language)} title={t("metrics.powerDriver")}/>
      <Row label={t("metrics.powerLimit")} value={runtime.gpu.powerLimitW != null && runtime.gpu.powerLimitW > 0 ? formatGpuWatts(runtime.gpu.powerLimitW, i18n.language) : "—"}/>
      <Row label={t("metrics.clock")} value={`${(runtime.gpu.clockMHz / 1000).toFixed(1)} GHz`}/>
    </div><LiveSparkline values={history.map(point => point.vramMiB)} tone="green" label={t("metrics.vram")}/></div>
    <Progress tone="green" value={runtime.gpu.memoryTotalMiB ? runtime.gpu.memoryUsedMiB / runtime.gpu.memoryTotalMiB * 100 : 0}/>
  </Panel>;

  if (widget === "hardware.cpu") return <Panel className="hardwareCard">
    <div className="cardTitle">CPU — <span className="blueText">{runtime.cpu.name}</span></div>
    <div className="hardwareBody"><Gauge value={runtime.cpu.utilization} tone="blue"/><div className="hardwareRows">
      <Row label={t("metrics.threads")} value={String(runtime.cpu.threads)}/>
      <Row label={t("metrics.clock")} value={runtime.cpu.clockMHz ? `${(runtime.cpu.clockMHz / 1000).toFixed(1)} GHz` : "—"}/>
      <Row label={t("metrics.temperature")} value={runtime.cpu.temperatureC ? `${runtime.cpu.temperatureC} °C` : "—"}/>
    </div></div>
    <Progress value={runtime.cpu.utilization}/>
  </Panel>;

  if (widget === "hardware.memory") return <Panel className="hardwareCard">
    <div className="cardTitle" title={memoryHardware.name || undefined}>{t("metrics.memory")}{memoryHardware.name && <> — <span className="violetText">{memoryHardware.name}</span></>}</div>
    <div className="hardwareBody"><Gauge value={ramPercent} tone="violet"/><div className="hardwareRows">
      <Row label="RAM" value={`${gib(runtime.memory.usedMiB)} / ${gib(runtime.memory.totalMiB)} GB`}/>
      {memoryHardware.capacity && <Row label={t("metrics.memoryModules")} value={memoryHardware.capacity}/>}
      {memoryHardware.speed && <Row label={t("metrics.memorySpeed")} value={memoryHardware.speed}/>}
      <Row label={t("metrics.used")} value={`${Math.round(ramPercent)}%`}/>
    </div></div>
    <Progress tone="violet" value={ramPercent}/>
  </Panel>;

  return null;
}
