import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useControlStore } from "../../store/control";
import { runColor } from "../launches/presentation";
import { compareWithPrevious, useRunStats } from "./runStats";

const number = (value: number, language: string, digits = 1) => value.toLocaleString(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Before/after chips for the selected run: speed and VRAM against its previous launch this session. */
export function DeltaChips({ runId, generation }: { runId: string; generation: number }) {
  const { t, i18n } = useTranslation();
  useRunStats(state => state.series);
  const delta = compareWithPrevious(runId, generation);
  if (!delta) return null;
  const tps = Math.round(delta.tpsDeltaPct);
  const vram = delta.vramDeltaGiB;
  return <span className="kDeltas" title={t("delta.title")}>
    {Math.abs(tps) >= 2 && <span className={`kDelta ${tps > 0 ? "isGood" : "isBad"}`}>{tps > 0 ? "+" : "−"}{Math.abs(tps)}% {t("island.tpsUnit")}</span>}
    {vram !== null && Math.abs(vram) >= 0.2 && <span className={`kDelta ${vram < 0 ? "isGood" : "isBad"}`}>{vram > 0 ? "+" : "−"}{number(Math.abs(vram), i18n.language)} {t("k.unit.gb")} VRAM</span>}
  </span>;
}

export function GenerationIsland() {
  const { t, i18n } = useTranslation();
  const runs = useControlStore(state => state.runs);
  const selectedRunId = useControlStore(state => state.selectedRunId);
  const run = runs.find(item => item.info.runId === selectedRunId);
  const series = useRunStats(state => run ? state.series[`${run.info.runId}#${run.info.generation}`] : undefined);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [open]);

  if (!run || !["ready", "busy"].includes(run.info.state)) return null;
  const runtime = run.runtime;
  const generating = runtime.generationTps > 0 || runtime.activeRequests > 0 || run.info.state === "busy";
  const samples = series?.samples ?? [];
  const recent = samples.slice(-60);
  const max = Math.max(1, ...recent.map(sample => sample.tps));
  const points = recent.map((sample, index) => `${(index / Math.max(1, recent.length - 1)) * 240},${44 - (sample.tps / max) * 40}`).join(" ");
  const active = recent.filter(sample => sample.tps > 0);
  const minuteAverage = active.length ? active.reduce((sum, sample) => sum + sample.tps, 0) / active.length : null;
  const contextShare = runtime.contextTotal > 0 ? runtime.contextUsed / runtime.contextTotal : 0;

  return <div ref={root} className={`kIsland${generating ? " isLive" : ""}${open ? " isOpen" : ""}`} style={{ ["--c" as string]: runColor(run.info.runId) }}>
    <button type="button" className="kIslandPill" aria-expanded={open} aria-controls="generation-island" onClick={() => setOpen(value => !value)}
      title={t("island.title")}>
      <i aria-hidden="true"/>
      {generating
        ? <><b className="kMono">{number(runtime.generationTps, i18n.language)}</b><span>{t("island.tpsUnit")}</span></>
        : <span>{t("island.ready")}</span>}
    </button>
    {open && <div id="generation-island" className="kIslandPanel" role="dialog" aria-label={t("island.title")}>
      <header><b>{run.info.name}</b><span className="kMuted">{t(`status.${run.info.state}`)}</span></header>
      <div className="kIslandRow"><span>{t("island.speedMinute")}</span><b className="kMono">{minuteAverage === null ? "—" : `${number(minuteAverage, i18n.language)} ${t("island.tpsUnit")}`}</b></div>
      <svg viewBox="0 0 240 46" preserveAspectRatio="none" aria-hidden="true" className="kIslandSpark">
        {recent.length > 1 ? <><polyline points={`0,46 ${points} 240,46`} className="area"/><polyline points={points} className="line"/></> : <line x1="0" x2="240" y1="44" y2="44" className="line"/>}
      </svg>
      <div className="kIslandRow"><span>{t("island.prompt")}</span><b className="kMono">{runtime.promptTps > 0 ? `${number(runtime.promptTps, i18n.language, 0)} ${t("island.tpsUnit")}` : "—"}</b></div>
      <div className="kIslandRow"><span>{t("island.ttft")}</span><b className="kMono">{runtime.ttftMs != null ? `${Math.round(runtime.ttftMs)} ${t("island.ms")}` : "—"}</b></div>
      {runtime.contextTotal > 0 && <div className="kIslandRow isStack"><span>{t("island.context")}<b className="kMono">{Math.round(runtime.contextUsed / 1024 * 10) / 10}K / {Math.round(runtime.contextTotal / 1024)}K</b></span>
        <span className="kIslandBar"><span style={{ width: `${Math.min(100, contextShare * 100)}%` }}/></span></div>}
      <div className="kIslandRow"><span>{t("island.requests")}</span><b className="kMono">{runtime.activeRequests} / {runtime.queuedRequests}</b></div>
      <DeltaChips runId={run.info.runId} generation={run.info.generation}/>
    </div>}
  </div>;
}
