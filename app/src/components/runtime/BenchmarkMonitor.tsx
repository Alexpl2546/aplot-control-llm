import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { Panel } from "../ui/Primitives";
import { LiveSparkline } from "./LiveSparkline";

export function BenchmarkMonitor() {
  const { t, i18n } = useTranslation();
  const { runtime: r, history, benchmarkProgress: progress, benchmarkEvents, optimizerRunning, optimizerProgress, logs } = useControlStore();
  const active = optimizerRunning || Boolean(progress && !["completed", "failed"].includes(progress.phase));
  const pct = progress?.total ? Math.min(100, (progress.completed ?? 0) / progress.total * 100) : undefined;
  const inferenceState = r.slots.some(slot => slot.state === "generating") ? "generating" : r.slots.some(slot => slot.state === "prompt") ? "prompt" : r.queuedRequests > 0 ? "queued" : "idle";
  const metrics = [
    { label: t("metrics.generation"), value: r.metricsAvailable ? `${r.generationTps.toFixed(1)} tok/s` : "—", values: history.map(p => p.generationTps) },
    { label: t("metrics.prompt"), value: r.metricsAvailable ? `${r.promptTps.toFixed(0)} tok/s` : "—", values: history.map(p => p.promptTps) },
    { label: "GPU", value: `${r.gpu.utilization.toFixed(0)}%`, values: history.map(p => p.gpu), note: r.gpu.name },
    { label: "VRAM", value: `${(r.gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(r.gpu.memoryTotalMiB / 1024).toFixed(1)} GB`, values: history.map(p => p.vramMiB) },
    { label: t("benchmark.live.temperature"), value: `${r.gpu.temperatureC.toFixed(0)} °C`, values: history.map(p => p.gpuTemperatureC) },
    { label: t("benchmark.live.power"), value: `${r.gpu.powerW.toFixed(0)} W`, values: history.map(p => p.gpuPowerW) },
    { label: "CPU", value: `${r.cpu.utilization.toFixed(0)}%`, values: history.map(p => p.cpu), note: r.cpu.name },
    { label: "RAM", value: `${(r.memory.usedMiB / 1024).toFixed(1)} / ${(r.memory.totalMiB / 1024).toFixed(1)} GB`, values: history.map(p => p.ramMiB) },
  ];
  return <Panel className="benchmarkMonitor">
    <div className="benchmarkLiveHeader"><h3>{t("benchmark.live.title")}</h3><span className={active ? "liveIndicator" : ""}>{t(progress ? `benchmark.phase.${progress.phase}` : "benchmark.live.idle")}</span></div>
    <div className="benchmarkStateChips" aria-label={t("benchmark.live.modelState")}>{(["idle", "prompt", "generating", "queued"] as const).map(state => <span key={state} className={state === inferenceState ? "active" : ""}>{t(`benchmark.inference.${state}`)}</span>)}</div>
    {optimizerRunning && optimizerProgress && <p className="benchmarkHint">{optimizerProgress.candidate} · {optimizerProgress.current}/{optimizerProgress.total}</p>}
    {progress && <div className="benchmarkLiveProgress" role="status"><span>{t("benchmark.live.steps", { completed: progress.completed ?? 0, total: progress.total || "—" })}{progress.run ? ` · ${t("benchmark.live.position", { run: progress.run, window: progress.window })}` : ""}</span><progress aria-label={t("benchmark.live.title")} max={100} value={pct}/></div>}
    <div className="benchmarkLiveMetrics">{metrics.map((metric, index) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong>{metric.note && <small title={metric.note}>{metric.note}</small>}<LiveSparkline values={metric.values} tone={index % 2 ? "blue" : "green"} label={metric.label}/></div>)}</div>
    <div className="benchmarkContext"><span>{t("benchmark.live.context")} · {r.contextUsed.toLocaleString(i18n.language)} / {r.contextTotal.toLocaleString(i18n.language)}</span><progress aria-label={t("benchmark.live.context")} value={r.contextUsed} max={r.contextTotal || 1}/><small>{t("benchmark.live.contextHint")}</small></div>
    <details className="benchmarkEventList" open={active || undefined}><summary>{t("benchmark.live.events")}</summary>{benchmarkEvents.length ? benchmarkEvents.slice(-8).map((event, index) => <div key={`${event.timestamp}-${index}`}><time>{new Date(event.timestamp).toLocaleTimeString(i18n.language)}</time><span>{t(`benchmark.phase.${event.phase}`)}{event.run ? ` · ${t("benchmark.live.position", { run: event.run, window: event.window })}` : ""}{event.sample ? ` · ${event.sample.generationTps.toFixed(1)} tok/s${event.sample.qualityTotal != null ? ` · ${event.sample.qualityMatches}/${event.sample.qualityTotal}` : ""}` : ""}</span></div>) : <p>{t("benchmark.live.noEvents")}</p>}</details>
    {active && logs.length > 0 && <details className="benchmarkEventList"><summary>{t("benchmark.live.serverEvents")}</summary>{logs.slice(-6).map(line => <div key={line.id}><time>{new Date(line.timestamp).toLocaleTimeString(i18n.language)}</time><span>{line.message}</span></div>)}</details>}
  </Panel>;
}
