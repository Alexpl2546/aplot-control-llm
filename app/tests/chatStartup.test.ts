import { beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { DEFAULT_CONFIG, DEFAULT_CAPABILITIES } from '../src/types/config';
import { DEFAULT_SETTINGS } from '../src/types/app';

vi.mock('../src/store/control', () => ({ useControlStore: create(() => ({})) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true, createRunStartRequest: vi.fn().mockResolvedValue({ runId: 'target' }) }));
import { invoke } from '@tauri-apps/api/core';
import { useControlStore } from '../src/store/control';
import { ensureChatRun, chatRunTarget, memoryReleaseProposal, type ChatRun } from '../src/features/chat/startup';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import type { NativeResourcePlan } from '../src/features/resources/ResourcePlanPanel';

const GiB = 1024 ** 3;
const run = (runId = 'target', state = 'stopped', ramMiB = 0, vramMiB = 0) => ({
  info: { runId, generation: 0, startedAt: undefined, state, modelId: 'model', name: runId, engine: 'strata', managed: true, mode: 'single' },
  config: { ...DEFAULT_CONFIG, profileId: runId, engine: 'strata', modelPath: `${runId}.gguf` }, settings: { ...DEFAULT_SETTINGS, serverEngine: 'strata' },
  runtime: { processMemory: { ramMiB, vramMiB }, memory: { totalMiB: 64000 }, gpu: { memoryTotalMiB: 24000 }, activeRequests: 0 },
}) as ChatRun;
const plan = (ram = 50, gpu = 20) => ({ contractVersion: 1, automaticApplication: false,
  availability: { ram: { baseFreeBytes: ram * GiB }, gpus: { gpu0: { baseFreeBytes: gpu * GiB } } },
  candidates: [{ id: 'configured', status: 'unknown', estimate: { ram: { min: 0, max: null }, gpus: {} } }], activeRuns: [],
}) as unknown as NativeResourcePlan;
const putRuns = (runs: ChatRun[]) => useControlStore.setState({ runs });

beforeEach(() => {
  vi.clearAllMocks();
  const target = run();
  useControlStore.setState({ runs: [target], selectedRunId: undefined, profiles: [], capabilities: DEFAULT_CAPABILITIES,
    runDrafts: {}, runBusyById: {}, optimizerRunning: false, refreshManagedRuns: vi.fn().mockResolvedValue(undefined),
    startManagedRun: vi.fn().mockImplementation(async () => { putRuns(useControlStore.getState().runs.map(item => item.info.runId === 'target'
      ? { ...item, info: { ...item.info, state: 'ready', generation: 1, startedAt: 'new-start' } } : item)); }),
    stopManagedRun: vi.fn().mockImplementation(async id => { putRuns(useControlStore.getState().runs.map(item => item.info.runId === id
      ? { ...item, info: { ...item.info, state: 'stopped' } } : item)); }),
  });
  useChatStore.setState({ selectedId: 'chat', threads: { chat: { ...EMPTY_THREAD, draft: 'Keep this message' } }, conversations: {
    chat: { id: 'chat', title: '', createdAt: 0, updatedAt: 0, target: chatRunTarget(target) },
  } });
  vi.mocked(invoke).mockResolvedValue(plan());
});

it('starts the selected saved server and binds the conversation to its actual generation', async () => {
  const permission = vi.fn();
  const ready = await ensureChatRun('chat', permission, new AbortController().signal, vi.fn());
  expect(ready.info.state).toBe('ready');
  expect(useControlStore.getState().startManagedRun).toHaveBeenCalledWith('target');
  expect(useChatStore.getState().conversations.chat.target).toMatchObject({ generation: 1, startedAt: 'new-start' });
  expect(useChatStore.getState().threads.chat.draft).toBe('Keep this message');
  expect(permission).not.toHaveBeenCalled();
});

it('reuses a ready server without starting or checking memory', async () => {
  putRuns([run('target', 'ready')]);
  await ensureChatRun('chat', vi.fn(), new AbortController().signal, vi.fn());
  expect(invoke).not.toHaveBeenCalled();
  expect(useControlStore.getState().startManagedRun).not.toHaveBeenCalled();
});

it('keeps both servers and the draft when permission to release memory is declined', async () => {
  putRuns([run(), run('other', 'ready', 10000, 20000)]);
  vi.mocked(invoke).mockResolvedValue(plan(50, 1));
  await expect(ensureChatRun('chat', vi.fn().mockResolvedValue(false), new AbortController().signal, vi.fn())).rejects.toThrow('cancelled');
  expect(useControlStore.getState().stopManagedRun).not.toHaveBeenCalled();
  expect(useControlStore.getState().startManagedRun).not.toHaveBeenCalled();
  expect(useChatStore.getState().threads.chat.draft).toBe('Keep this message');
});

it('stops only the approved server, checks memory again, then starts the chosen model', async () => {
  putRuns([run(), run('other', 'ready', 10000, 20000), run('unrelated', 'ready', 2000, 100)]);
  vi.mocked(invoke).mockResolvedValueOnce(plan(50, 1)).mockResolvedValue(plan());
  const permission = vi.fn().mockResolvedValue(true);
  await ensureChatRun('chat', permission, new AbortController().signal, vi.fn());
  expect(permission.mock.calls[0][0].map((item: ChatRun) => item.info.runId)).toEqual(['other']);
  expect(useControlStore.getState().stopManagedRun).toHaveBeenCalledExactlyOnceWith('other');
  expect(useControlStore.getState().runs.find(item => item.info.runId === 'unrelated')?.info.state).toBe('ready');
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('requires new permission if the proposed server restarts while the dialog is open', async () => {
  putRuns([run(), run('other', 'ready', 10000, 20000)]);
  vi.mocked(invoke).mockResolvedValue(plan(50, 1));
  const permission = async () => { putRuns([run(), { ...run('other', 'ready', 10000, 20000), info: { ...run('other').info, state: 'ready', generation: 2 } }]); return true; };
  await expect(ensureChatRun('chat', permission, new AbortController().signal, vi.fn())).rejects.toThrow('changed');
  expect(useControlStore.getState().stopManagedRun).not.toHaveBeenCalled();
});

it('does not start a changed model after awaiting permission', async () => {
  putRuns([run(), run('other', 'ready', 10000, 20000)]);
  vi.mocked(invoke).mockResolvedValue(plan(50, 1));
  const permission = async () => { const target = run(); putRuns([{ ...target, config: { ...target.config, modelPath: 'different.gguf' } }]); return true; };
  await expect(ensureChatRun('chat', permission, new AbortController().signal, vi.fn())).rejects.toThrow('changed');
  expect(useControlStore.getState().stopManagedRun).not.toHaveBeenCalled();
  expect(useControlStore.getState().startManagedRun).not.toHaveBeenCalled();
});

it('preserves the draft on launch failure and cancellation', async () => {
  useControlStore.setState({ startManagedRun: vi.fn().mockRejectedValue(new Error('engine failed')) });
  await expect(ensureChatRun('chat', vi.fn(), new AbortController().signal, vi.fn())).rejects.toThrow('engine failed');
  const abort = new AbortController(); abort.abort();
  await expect(ensureChatRun('chat', vi.fn(), abort.signal, vi.fn())).rejects.toThrow('cancelled');
  expect(useChatStore.getState().threads.chat.draft).toBe('Keep this message');
});

it('prefers an idle process in the constrained pool and leaves external servers alone', () => {
  const target = run(), gpu = run('gpu', 'busy', 1000, 20000), cpu = run('cpu', 'ready', 20000, 0);
  expect(memoryReleaseProposal(target, [target, cpu, gpu], plan(50, 1)).map(item => item.info.runId)).toEqual(['gpu']);
  expect(memoryReleaseProposal(target, [target, { ...gpu, info: { ...gpu.info, managed: false } }], plan(50, 1))).toEqual([]);
});
