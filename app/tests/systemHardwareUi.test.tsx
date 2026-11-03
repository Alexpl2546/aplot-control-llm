// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/types/config';
import { DEFAULT_SETTINGS } from '../src/types/app';
import { MOCK_RUNTIME } from '../src/mocks/runtime';
import type { SystemHardwareSnapshot } from '../src/types/runtime';
vi.mock('../src/services/systemHardware', () => ({ readSystemHardware: vi.fn() }));
import { readSystemHardware } from '../src/services/systemHardware';
import { useControlStore } from '../src/store/control';
import { useMemoryModels, useSystemHardware } from '../src/components/shell/useShellData';

const hardware = { gpu: { ...MOCK_RUNTIME.gpu, memoryTotalMiB: 16384, memoryUsedMiB: 14000, utilization: 34 },
  memory: { totalMiB: 65536, usedMiB: 42000 }, cpu: { ...MOCK_RUNTIME.cpu, utilization: 18 } };
const emptyRuntime = { ...MOCK_RUNTIME, gpu: { ...MOCK_RUNTIME.gpu, memoryTotalMiB: 0, memoryUsedMiB: 0, utilization: 0 },
  memory: { totalMiB: 0, usedMiB: 0 }, cpu: { ...MOCK_RUNTIME.cpu, utilization: 0 }, state: 'stopped' as const };
type Run = ReturnType<typeof useControlStore.getState>['runs'][number];
const run = (id: string, remembered = false): Run => ({ remembered,
  info: { runId: id, name: id, state: remembered ? 'stopped' : 'ready', engine: 'strata', mode: 'single', endpoint: 'http://127.0.0.1:8090',
    modelId: id, contextTokens: 32768, generation: 1, managed: true },
  config: { ...DEFAULT_CONFIG, profileId: id }, settings: DEFAULT_SETTINGS, history: [], logs: [],
  runtime: remembered ? emptyRuntime : { ...MOCK_RUNTIME, ...hardware, processMemory: { ramMiB: 25000, vramMiB: 12000, pids: [1], sampledAtMs: Date.now() } },
});
beforeEach(() => {
  vi.clearAllMocks();
  const active = run('active');
  useControlStore.setState({ systemHardware: hardware, runs: [active, run('stopped', true)], selectedRunId: 'active', runtime: active.runtime,
    config: active.config, settings: active.settings, runDrafts: {}, runBusyById: {}, dirty: false });
  vi.mocked(readSystemHardware).mockResolvedValue(hardware);
});
afterEach(cleanup);

it('keeps computer totals, utilization and all running-model shares when a stopped server is selected', () => {
  const { result } = renderHook(() => ({ memory: useMemoryModels(), hardware: useSystemHardware() }));
  act(() => useControlStore.getState().selectRun('stopped'));
  expect(useControlStore.getState().runtime).toMatchObject({ state: 'stopped', gpu: { memoryTotalMiB: 0 } });
  expect(result.current.hardware).toBe(hardware);
  expect(result.current.memory.vram.totalGib).toBe(16);
  expect(result.current.memory.ram.measuredGib).toBe(42000 / 1024);
  expect(result.current.memory.vram.segments[0]).toMatchObject({ runId: 'active', gib: 12000 / 1024, basis: 'measured' });
  act(() => useControlStore.getState().selectRun('active'));
  expect(result.current.hardware.gpu.utilization).toBe(34);
});

it('continues sampling hardware when only remembered stopped servers exist', async () => {
  useControlStore.setState({ runs: [run('stopped', true)], selectedRunId: 'stopped', runtime: emptyRuntime });
  const updated = { ...hardware, memory: { totalMiB: 65536, usedMiB: 44000 } };
  vi.mocked(readSystemHardware).mockResolvedValue(updated);
  await act(async () => { await useControlStore.getState().refreshRuntime(); await useControlStore.getState().refreshSystemHardware(); });
  expect(useControlStore.getState().systemHardware.memory.usedMiB).toBe(44000);
  expect(useControlStore.getState().runtime.state).toBe('stopped');
});

it('deduplicates slow sensor polls and applies their result regardless of server selection', async () => {
  let resolve!: (value: SystemHardwareSnapshot) => void;
  vi.mocked(readSystemHardware).mockReturnValue(new Promise(done => { resolve = done; }));
  const first = useControlStore.getState().refreshSystemHardware();
  expect(useControlStore.getState().refreshSystemHardware()).toBe(first);
  act(() => useControlStore.getState().selectRun('stopped'));
  await act(async () => { resolve({ ...hardware, cpu: { ...hardware.cpu, utilization: 50 } }); await first; });
  expect(readSystemHardware).toHaveBeenCalledTimes(1);
  expect(useControlStore.getState().systemHardware.cpu.utilization).toBe(50);
});

it('retains last measurements on a sensor failure without raising a server error', async () => {
  useControlStore.setState({ error: undefined });
  vi.mocked(readSystemHardware).mockRejectedValue(new Error('sensor unavailable'));
  await act(async () => { await useControlStore.getState().refreshSystemHardware(); });
  expect(useControlStore.getState().systemHardware).toBe(hardware);
  expect(useControlStore.getState().error).toBeUndefined();
});
