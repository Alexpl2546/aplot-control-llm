import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { isActive, runColor } from "../../features/launches/presentation";
import { formatGb, MemoryRuler, MemoryTrack } from "./MemoryTrack";
import { useMemoryModels } from "./useShellData";

/** Measured process-tree shares and system remainder; estimates remain explicitly marked. */
export function MemoryMap() {
  const { t, i18n } = useTranslation();
  const runs = useControlStore(state => state.runs);
  const runtime = useControlStore(state => state.runtime);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const selectRun = useControlStore(state => state.selectRun);
  const { vram, ram } = useMemoryModels();
  const unit = t("k.unit.gb");
  const fmt = (value: number) => formatGb(value, i18n.language);
  const active = runs.map((run, index) => ({ run, index })).filter(({ run }) => isActive(run.info.state));
  const unestimated = [...new Set([...vram.unestimated, ...ram.unestimated].map(run => run.info.name))];
  const share = (model: typeof vram, id: string) => {
    const segment = model.segments.find(s => s.runId === id);
    return segment ? `${segment.basis === 'estimate' || model.scaled ? '≈' : ''}${fmt(segment.gib)}` : '—';
  };
  const row = (label: string, device: string, model: typeof vram) => <div className="kMemRow">
    <div className="kMemLabel"><b>{label}</b><small title={device}>{device}</small></div>
    <div><MemoryTrack model={model} selectedRunId={selectedRunId}/><MemoryRuler model={model}/></div>
    <div className="kMemTotal"><b className="kMono">{fmt(model.measuredGib)} <span>/ {fmt(model.totalGib)}</span></b><small>{t("k.free", { value: fmt(Math.max(0, model.totalGib - model.measuredGib)) })}</small></div>
  </div>;
  return <section className="panel kMemMap" aria-labelledby="k-memmap-title" title={[t("k.mem.note"), unestimated.length ? t("k.mem.unestimated", { names: unestimated.join(", ") }) : ""].filter(Boolean).join(". ")}>
    <header className="kCardHead"><h3 id="k-memmap-title">{t("k.mem.title")}</h3></header>
    {row("VRAM", runtime.gpu.name, vram)}
    {row("RAM", runtime.cpu.name, ram)}
    <div className="kMemLegend">
      {active.map(({ run, index }) => {
        return <button type="button" key={run.info.runId} className={run.info.runId === selectedRunId ? "isOn" : ""} onClick={() => selectRun(run.info.runId)}>
          <i style={{ background: runColor(run.info.runId) }}/>{t("k.serverNumber", { number: index + 1 })} {run.info.name}
          <b className="kMono">VRAM {share(vram, run.info.runId)} · RAM {share(ram, run.info.runId)} {unit}</b>
        </button>;
      })}
      <span className="kLegendOther"><i/>{t("k.mem.other")}</span>
    </div>
    {!active.length && <p className="kMemNote">{t("k.mem.noRuns")}</p>}
    {(vram.scaled || ram.scaled) && <p className="kMemNote isWarn"><AlertTriangle size={13}/>{t("k.mem.scaled", { kinds: [vram.scaled && "VRAM", ram.scaled && "RAM"].filter(Boolean).join(" / ") })}</p>}
  </section>;
}
