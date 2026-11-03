import { beforeEach, expect, it, vi } from 'vitest';
import { MOCK_RUNTIME } from '../src/mocks/runtime';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));
import { invoke } from '@tauri-apps/api/core';
import { readSystemHardware } from '../src/services/systemHardware';

const previous = { gpu: MOCK_RUNTIME.gpu, cpu: MOCK_RUNTIME.cpu, memory: MOCK_RUNTIME.memory };
beforeEach(() => vi.clearAllMocks());

it('reads system telemetry without a server identifier or model connection', async () => {
  vi.mocked(invoke).mockResolvedValue({ cpuName: 'CPU', cpuUtilization: 17, cpuThreads: 16, cpuClockMHz: 4000, cpuTemperatureC: 42,
    memoryTotalMiB: 65536, memoryUsedMiB: 42000, memoryModules: [], gpu: { ...MOCK_RUNTIME.gpu, utilization: 33, memoryUsedMiB: 14000 } });
  expect(await readSystemHardware(previous)).toMatchObject({ cpu: { name: 'CPU', utilization: 17, temperatureC: 42 },
    memory: { usedMiB: 42000, totalMiB: 65536 }, gpu: { utilization: 33, memoryUsedMiB: 14000 } });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('hardware_snapshot');
});

it('keeps other sensors and the last GPU reading when one sensor is temporarily unavailable', async () => {
  vi.mocked(invoke).mockResolvedValue({ cpuName: 'CPU', cpuUtilization: 0, cpuThreads: 16, cpuClockMHz: 4000, cpuTemperatureC: null,
    memoryTotalMiB: 65536, memoryUsedMiB: 0, memoryModules: [], gpu: null });
  const sample = await readSystemHardware(previous);
  expect(sample.gpu).toBe(previous.gpu);
  expect(sample.cpu.utilization).toBe(0);
  expect(sample.memory.usedMiB).toBe(0);
  expect(sample.memory.totalMiB).toBe(65536);
});
