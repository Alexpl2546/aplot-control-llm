import { create } from "zustand";
import { useControlStore } from "../../store/control";

/** One telemetry sample of a server process generation (a restart starts a new generation). */
export interface RunSample { t: number; tps: number; promptTps: number; vramGiB: number | null; }
interface Series { runId: string; generation: number; name: string; samples: RunSample[]; startedAt: number; }

const MAX_SAMPLES = 180;
const key = (runId: string, generation: number) => `${runId}#${generation}`;

export const useRunStats = create<{ series: Record<string, Series> }>(() => ({ series: {} }));

/** Feeds the store from the control store's run snapshots; returns the unsubscribe function. */
export function startRunStats() {
  let last = 0;
  return useControlStore.subscribe(state => {
    const now = Date.now();
    if (now - last < 450) return;
    last = now;
    const series = { ...useRunStats.getState().series };
    let changed = false;
    for (const run of state.runs) {
      if (!["ready", "busy"].includes(run.info.state)) continue;
      const id = key(run.info.runId, run.info.generation);
      const current = series[id] ?? { runId: run.info.runId, generation: run.info.generation, name: run.info.name, samples: [], startedAt: now };
      const vram = run.runtime.processMemory?.vramMiB;
      const sample: RunSample = { t: now, tps: run.runtime.generationTps || 0, promptTps: run.runtime.promptTps || 0, vramGiB: typeof vram === "number" ? vram / 1024 : null };
      series[id] = { ...current, samples: [...current.samples.slice(-(MAX_SAMPLES - 1)), sample] };
      changed = true;
    }
    if (changed) useRunStats.setState({ series });
  });
}

export function seriesFor(runId: string, generation: number) {
  return useRunStats.getState().series[key(runId, generation)];
}

function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

/** Averages only over samples where the server was actually generating. */
export function summarize(series: Series | undefined) {
  if (!series) return { tps: null, vramGiB: null, active: 0 };
  const generating = series.samples.filter(sample => sample.tps > 0);
  const vram = series.samples.map(sample => sample.vramGiB).filter((value): value is number => value !== null);
  return { tps: average(generating.map(sample => sample.tps)), vramGiB: vram.length ? vram[vram.length - 1]! : null, active: generating.length };
}

/**
 * Compares the current generation of a run with the previous one recorded this session.
 * Returns undefined until both sides have enough generating samples to be meaningful.
 */
export function compareWithPrevious(runId: string, generation: number) {
  const all = Object.values(useRunStats.getState().series).filter(item => item.runId === runId && item.generation < generation).sort((a, b) => b.generation - a.generation);
  const before = summarize(all[0]), after = summarize(seriesFor(runId, generation));
  if (before.active < 5 || after.active < 5 || before.tps === null || after.tps === null) return undefined;
  return {
    tpsDeltaPct: ((after.tps - before.tps) / before.tps) * 100,
    vramDeltaGiB: before.vramGiB !== null && after.vramGiB !== null ? after.vramGiB - before.vramGiB : null,
  };
}
