import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { estimateResources } from "../../lib/resources";
import { useControlStore } from "../../store/control";
import { runColor } from "../launches/presentation";
import { formatGb, MemoryRuler } from "../../components/shell/MemoryTrack";
import { useMemoryModels } from "../../components/shell/useShellData";
import type { LaunchConfig } from "../../types/config";

/**
 * "Will it fit?" — the VRAM track with the servers already running plus a hatched ghost for the one
 * about to launch. `replacesRunId` is the server being restarted with this config: its current share is
 * released first. Only llama.cpp configs with known model size have an estimate; others render nothing.
 */
export function LaunchFit({ config, replacesRunId, compact = false }: { config?: LaunchConfig; replacesRunId?: string; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const { vram } = useMemoryModels();
  const runs = useControlStore(state => state.runs);
  const estimate = useMemo(() => config && (config.engine ?? "llama_cpp") === "llama_cpp" && config.modelBytes ? estimateResources(config, vram.totalGib || 16) : undefined, [config, vram.totalGib]);
  if (!estimate || vram.totalGib <= 0) return null;

  const kept = vram.segments.filter(segment => segment.runId !== replacesRunId);
  const released = vram.segments.find(segment => segment.runId === replacesRunId)?.gib ?? 0;
  const used = Math.max(0, vram.measuredGib - released);
  const free = Math.max(0, vram.totalGib - used);
  const need = estimate.estimatedVramGiB;
  const fits = need <= free;
  const tight = fits && free - need < 0.75;
  const scale = vram.totalGib;
  const pct = (value: number) => `${Math.max(0, value) / scale * 100}%`;
  const others = Math.max(0, used - kept.reduce((sum, segment) => sum + segment.gib, 0));
  const largest = [...kept].sort((a, b) => b.gib - a.gib)[0];
  const number = (value: number) => formatGb(value, i18n.language);
  const unit = t("k.unit.gb");
  const verdict = !fits
    ? t("fit.over", { need: number(need), free: number(free), unit })
    : tight ? t("fit.tight", { left: number(free - need), unit }) : t("fit.ok", { left: number(free - need), unit });
  const advice = !fits ? [
    config && config.ctxSize > 8192 ? t("fit.lowerContext") : null,
    config && config.kvOffload ? t("fit.kvToRam") : null,
    largest ? t("fit.stopServer", { name: `${t("k.serverNumber", { number: largest.index + 1 })} ${largest.name}` }) : null,
  ].filter(Boolean).join(" · ") : "";

  return <div className={`kFit${fits ? tight ? " isTight" : " isOk" : " isOver"}${compact ? " isCompact" : ""}`} role="group" aria-label={t("fit.title")}>
    <div className="kFitHead"><b>{t("fit.title")}</b><span className="kMono">{number(need)} {unit} · {t(estimate.confidence === "medium" ? "fit.estimate" : "fit.rough")}</span></div>
    <div className="kTrack is-vram">
      <div className="kSegs">
        {kept.map(segment => <span key={segment.runId} className="kSeg" style={{ flexBasis: pct(segment.gib), ["--c" as string]: runColor(segment.runId) }} title={`${segment.name} · ${number(segment.gib)} ${unit}`}>
          {segment.gib / scale > 0.12 && <em>{t("k.serverNumber", { number: segment.index + 1 })} · {number(segment.gib)}</em>}
        </span>)}
        {others > 0.05 && <span className="kSeg kOther" style={{ flexBasis: pct(others) }} title={t("k.mem.other")}/>}
        <span className="kSeg kGhost" style={{ flexBasis: pct(Math.min(need, free + 0.001)) }}>{Math.min(need, free) / scale > 0.12 && <em>{t("fit.new")} · {number(need)}</em>}</span>
      </div>
    </div>
    {!compact && <MemoryRuler model={vram}/>}
    <p className="kFitVerdict" role="status"><i aria-hidden="true"/>{verdict}{advice && <span> {advice}</span>}</p>
    {config?.fit && <p className="kFitNote">{t("resources.fitNote")}</p>}
  </div>;
}
