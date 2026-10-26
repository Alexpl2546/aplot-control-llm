import { estimateResources } from "../../lib/resources";
import type { LaunchConfig } from "../../types/config";
import type { RunInfo, RuntimeSnapshot } from "../../types/runtime";

export interface MemoryRun {
  info: Pick<RunInfo, "runId" | "name" | "state" | "engine" | "mode">;
  config: LaunchConfig;
  runtime?: Pick<RuntimeSnapshot, 'processMemory'>;
}
export interface MemorySegment { runId: string; name: string; index: number; gib: number; estimatedGib: number; basis: 'measured' | 'estimate'; }
export interface MemoryModel {
  kind: "vram" | "ram";
  totalGib: number;
  measuredGib: number;
  segments: MemorySegment[];
  otherGib: number;
  scaled: boolean;
  unestimated: MemoryRun[];
}

/** Prefer process-tree measurements across engines; retain honest llama.cpp estimates as fallback. */
export function memoryModel(kind: MemoryModel["kind"], runs: readonly MemoryRun[], totalMiB: number, usedMiB: number): MemoryModel {
  const totalGib = Math.max(0, totalMiB) / 1024, measuredGib = Math.max(0, usedMiB) / 1024;
  const segments: MemorySegment[] = [], unestimated: MemoryRun[] = [];
  runs.forEach((run, index) => {
    if (["stopped", "crashed"].includes(run.info.state)) return;
    const observation = run.runtime?.processMemory;
    const measured = kind === 'vram' ? observation?.vramMiB : observation?.ramMiB;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0 && observation && Date.now() - observation.sampledAtMs < 5000) {
      segments.push({ runId: run.info.runId, name: run.info.name, index, gib: measured / 1024, estimatedGib: measured / 1024, basis: 'measured' });
      return;
    }
    if (run.info.engine !== "llama_cpp" || run.info.mode !== "single" || !run.config.modelBytes) { unestimated.push(run); return; }
    const estimate = estimateResources(run.config);
    if (estimate.confidence !== "medium") { unestimated.push(run); return; }
    const value = kind === "vram" ? estimate.estimatedVramGiB : estimate.estimatedRamGiB;
    segments.push({ runId: run.info.runId, name: run.info.name, index, gib: value, estimatedGib: value, basis: 'estimate' });
  });
  const sum = segments.reduce((total, segment) => total + segment.gib, 0);
  const scaled = sum > measuredGib && sum > 0;
  if (scaled) segments.forEach(segment => { segment.gib = segment.gib / sum * measuredGib; });
  const otherGib = Math.max(0, measuredGib - segments.reduce((total, segment) => total + segment.gib, 0));
  return { kind, totalGib, measuredGib, segments, otherGib, scaled, unestimated };
}
