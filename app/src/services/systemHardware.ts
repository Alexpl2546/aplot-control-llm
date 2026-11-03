import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import { MOCK_RUNTIME } from '../mocks/runtime';
import type { GpuSnapshot, MemoryModule, SystemHardwareSnapshot } from '../types/runtime';

interface NativeHardwareSnapshot {
  cpuName: string;
  cpuUtilization: number;
  cpuThreads: number;
  cpuClockMHz: number;
  cpuTemperatureC: number | null;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  memoryModules: MemoryModule[];
  gpu: GpuSnapshot | null;
}

/** System telemetry does not require a selected, prepared or running model. */
export async function readSystemHardware(previous: SystemHardwareSnapshot): Promise<SystemHardwareSnapshot> {
  if (!isTauri()) return { gpu: MOCK_RUNTIME.gpu, cpu: MOCK_RUNTIME.cpu, memory: MOCK_RUNTIME.memory };
  const sample = await invoke<NativeHardwareSnapshot>('hardware_snapshot');
  return {
    gpu: sample.gpu ?? previous.gpu,
    cpu: sample.cpuThreads > 0 ? {
      name: sample.cpuName, utilization: sample.cpuUtilization, threads: sample.cpuThreads,
      clockMHz: sample.cpuClockMHz, temperatureC: sample.cpuTemperatureC ?? undefined,
    } : previous.cpu,
    memory: sample.memoryTotalMiB > 0 ? {
      usedMiB: sample.memoryUsedMiB, totalMiB: sample.memoryTotalMiB, modules: sample.memoryModules,
    } : previous.memory,
  };
}
