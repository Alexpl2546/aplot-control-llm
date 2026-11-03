import { useMemo } from "react";
import { useControlStore } from "../../store/control";
import { isActive } from "../../features/launches/presentation";
import { memoryModel } from "../../features/resources/memoryUsage";

export const useSystemHardware = () => useControlStore(state => state.systemHardware ?? state.runtime);

/** Computer-wide totals with process shares from every running server. */
export function useMemoryModels() {
  const runs = useControlStore(state => state.runs);
  const runtime = useSystemHardware();
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
