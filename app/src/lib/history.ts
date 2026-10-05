import type { RuntimeHistoryPoint, RuntimeSnapshot } from "../types/runtime";
export function appendRuntimeHistory(history: RuntimeHistoryPoint[], runtime: RuntimeSnapshot, max = 7200): RuntimeHistoryPoint[] {
  const point: RuntimeHistoryPoint = {
    timestamp: Date.now(),
    gpu: runtime.gpu.utilization,
    vramMiB: runtime.gpu.memoryUsedMiB,
    gpuTemperatureC: runtime.gpu.temperatureC,
    gpuPowerW: runtime.gpu.powerW,
    cpu: runtime.cpu.utilization,
    ramMiB: runtime.memory.usedMiB,
    generationTps: runtime.generationTps,
    generationMeanTps: runtime.generationMeanTps,
    promptTps: runtime.promptTps,
    activeRequests: runtime.activeRequests,
    queuedRequests: runtime.queuedRequests,
    ttftMs: runtime.ttftMs,
  };
  return [...history.slice(-(max - 1)), point];
}
