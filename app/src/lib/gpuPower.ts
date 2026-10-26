import type { GpuSnapshot } from '../types/runtime';

export function formatGpuWatts(value: number | null | undefined, language: string): string {
  return value != null && Number.isFinite(value) && value >= 0
    ? `${value.toLocaleString(language, { maximumFractionDigits: 1 })} W` : '—';
}

export function gpuPowerLabel(gpu: GpuSnapshot): string {
  if (gpu.powerW == null || !Number.isFinite(gpu.powerW) || gpu.powerW < 0) return 'metrics.power';
  return gpu.powerReading === 'instant' ? 'metrics.powerInstant'
    : gpu.powerReading === 'average' ? 'metrics.powerAverage' : 'metrics.power';
}
