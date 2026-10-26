import { useTranslation } from "react-i18next";
import type { MemoryModel } from "../../features/resources/memoryUsage";
import { runColor } from "../../features/launches/presentation";

const gb = (value: number, language: string) => value.toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function MemoryTrack({ model, thin = false, labels = true, selectedRunId }: { model: MemoryModel; thin?: boolean; labels?: boolean; selectedRunId?: string }) {
  const { t, i18n } = useTranslation();
  const scale = Math.max(model.totalGib, model.measuredGib) || 1;
  const pct = (value: number) => `${value / scale * 100}%`;
  const unit = t("k.unit.gb");
  const other = model.otherGib > 0.02 && <span className="kSeg kOther" style={{ flexBasis: pct(model.otherGib) }} title={`${t("k.mem.other")} · ${gb(model.otherGib, i18n.language)} ${unit}`}>
    {labels && model.otherGib / scale > 0.14 && <em>{t("k.mem.other")} {gb(model.otherGib, i18n.language)}</em>}
  </span>;
  const runs = model.segments.map(segment => <span key={segment.runId} className={`kSeg${segment.runId === selectedRunId ? " isSelected" : ""}`} style={{ flexBasis: pct(segment.gib), ["--c" as string]: runColor(segment.runId) }}
    title={`${t("k.serverNumber", { number: segment.index + 1 })} ${segment.name} · ${t(segment.basis === 'measured' ? "k.mem.processMeasured" : "k.mem.estimate")}: ${segment.basis === 'estimate' ? '≈' : ''}${gb(segment.estimatedGib, i18n.language)} ${unit}`}>
    {labels && segment.gib / scale > 0.08 && <em>{t("k.serverNumber", { number: segment.index + 1 })} · {segment.basis === 'estimate' || model.scaled ? '≈' : ''}{gb(segment.gib, i18n.language)}</em>}
  </span>);
  return <div className={`kTrack is-${model.kind}${thin ? " isThin" : ""}`} role="img" aria-label={`${model.kind.toUpperCase()} ${gb(model.measuredGib, i18n.language)} / ${gb(model.totalGib, i18n.language)} ${unit}`}>
    <div className="kSegs">{model.kind === "ram" ? <>{other}{runs}</> : <>{runs}{other}</>}</div>
  </div>;
}

export function MemoryRuler({ model }: { model: MemoryModel }) {
  const scale = Math.max(model.totalGib, model.measuredGib) || 1;
  const step = scale <= 24 ? 4 : scale <= 72 ? 8 : 16;
  const ticks = Array.from({ length: Math.floor(scale / step) + 1 }, (_, index) => index * step);
  return <div className="kRuler" aria-hidden="true">{ticks.map(value => <span key={value} style={{ left: `${value / scale * 100}%` }}>{value}</span>)}</div>;
}

export { gb as formatGb };
