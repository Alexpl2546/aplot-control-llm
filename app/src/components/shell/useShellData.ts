import { useMemo } from "react";
import { useControlStore } from "../../store/control";
import { isActive } from "../../features/launches/presentation";
import { memoryModel } from "../../features/resources/memoryUsage";

/** Hardware totals from the selected run's snapshot plus per-run shares for both memory kinds. */
export function useMemoryModels() {
  const runs = useControlStore(state => state.runs);
  const runtime = useControlStore(state => state.runtime);
  return useMemo(() => ({
    vram: memoryModel("vram", runs, runtime.gpu.memoryTotalMiB, runtime.gpu.memoryUsedMiB),
    ram: memoryModel("ram", runs, runtime.memory.totalMiB, runtime.memory.usedMiB),
  }), [runs, runtime.gpu.memoryTotalMiB, runtime.gpu.memoryUsedMiB, runtime.memory.totalMiB, runtime.memory.usedMiB]);
}

export function useRunCounts() {
  const runs = useControlStore(state => state.runs);
  return useMemo(() => ({
    total: runs.length,
    active: runs.filter(run => isActive(run.info.state)).length,
    crashed: runs.filter(run => run.info.state === "crashed").length,
  }), [runs]);
}
