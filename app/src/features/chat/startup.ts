import { invoke } from '@tauri-apps/api/core';
import { useControlStore } from '../../store/control';
import * as bridge from '../../services/tauri';
import { captureEngineOptions, restoreEngineOptions } from '../launches/profiles';
import type { NativeResourcePlan } from '../resources/ResourcePlanPanel';
import type { RunInfo } from '../../types/runtime';
import { sameChatTarget, type ChatTarget } from './historyModel';
import { useChatStore } from './store';

type Control = ReturnType<typeof useControlStore.getState>;
export type ChatRun = Control['runs'][number];
export type StartupStage = 'checking' | 'starting' | 'loading' | 'stopping';
export type ReleasePermission = (runs: ChatRun[]) => Promise<boolean>;
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const running = (run: ChatRun) => !['stopped', 'crashed', 'stopping'].includes(run.info.state);
const ready = (run: ChatRun) => ['ready', 'busy'].includes(run.info.state);
const cancelled = () => new Error('cancelled');
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };

export function chatRunTarget(run: ChatRun): ChatTarget {
  return { provider: 'local', runId: run.info.runId, generation: run.info.generation, label: run.info.name,
    engine: run.info.engine, modelId: run.info.modelId, startedAt: run.info.startedAt };
}
export function canStartChatRun(run?: ChatRun): boolean {
  return !!run && run.info.managed && run.info.state !== 'stopping';
}

function launchInput(state: Control, run: ChatRun) {
  const draft = state.selectedRunId === run.info.runId ? { config: state.config, settings: state.settings }
    : state.runDrafts[run.info.runId] ?? run;
  const settings = (draft.config.engine ?? 'llama_cpp') === draft.settings.serverEngine
    ? draft.settings : restoreEngineOptions(draft.config, draft.settings);
  const config = captureEngineOptions(draft.config, settings);
  return { config, settings, profiles: state.profiles, capabilities: state.capabilities, runId: run.info.runId, preview: true };
}
function fingerprint(state: Control, run: ChatRun) {
  return JSON.stringify(launchInput(state, run).config);
}

/** A proposal never stops a process. Unknown estimates use measured pressure,
 * while known estimates and previous samples use their actual memory pools. */
export function memoryReleaseProposal(target: ChatRun, runs: ChatRun[], plan: NativeResourcePlan): ChatRun[] {
  const others = runs.filter(run => run.info.runId !== target.info.runId && run.info.managed && running(run));
  if (!others.length) return [];
  const candidate = plan.candidates.find(item => item.id === 'configured');
  const previous = target.runtime.processMemory;
  const requiredRam = Math.max(candidate?.estimate.ram.min ?? 0, (previous?.ramMiB ?? 0) * MiB);
  const requiredGpu = Math.max(candidate?.estimate.gpus.gpu0?.min ?? 0, (previous?.vramMiB ?? 0) * MiB);
  const freeRam = plan.availability.ram.baseFreeBytes;
  const freeGpu = plan.availability.gpus.gpu0?.baseFreeBytes;
  const snapshot = others.find(run => run.runtime.memory.totalMiB > 0)?.runtime;
  const ramReserve = Math.max(4 * GiB, (snapshot?.memory.totalMiB ?? 0) * MiB * .2);
  const gpuReserve = Math.max(2 * GiB, (snapshot?.gpu.memoryTotalMiB ?? 0) * MiB * .2);
  const ramPressure = freeRam !== null && freeRam < (requiredRam > 0 ? requiredRam + GiB : ramReserve);
  const gpuPressure = freeGpu != null && freeGpu < (requiredGpu > 0 ? requiredGpu + .5 * GiB : gpuReserve);
  if (!ramPressure && !gpuPressure && candidate?.status !== 'insufficient') return [];
  const score = (run: ChatRun) => {
    const measured = run.runtime.processMemory;
    const estimate = plan.activeRuns.find(item => item.runId === run.info.runId && item.generation === run.info.generation)?.estimate;
    return (ramPressure ? (measured?.ramMiB ?? 0) * MiB || estimate?.ram.min || 0 : 0)
      + (gpuPressure ? (measured?.vramMiB ?? 0) * MiB || estimate?.gpus.gpu0?.min || 0 : 0);
  };
  // Free one useful allocation at a time, then measure again. Avoid interrupting
  // a busy server when an idle server can release the same memory pool.
  const useful = others.filter(run => score(run) > 0).sort((a, b) =>
    Number(a.info.state === 'busy' || a.runtime.activeRequests > 0) - Number(b.info.state === 'busy' || b.runtime.activeRequests > 0)
      || score(b) - score(a));
  return useful.slice(0, 1);
}

function pause(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function waitReady(runId: string, generation: number, signal: AbortSignal, stage: (value: StartupStage) => void) {
  const deadline = Date.now() + 60 * 60 * 1000;
  while (true) {
    checkAbort(signal);
    const state = useControlStore.getState(), run = state.runs.find(item => item.info.runId === runId);
    if (!run || run.info.generation !== generation) throw new Error('changed');
    if (ready(run)) return run;
    if (['stopped', 'crashed', 'stopping'].includes(run.info.state)) throw new Error(run.info.lastError || 'unavailable');
    if (Date.now() >= deadline) throw new Error('startupTimeout');
    stage('loading');
    await pause(signal, 1000);
    await useControlStore.getState().refreshManagedRuns();
  }
}

// Serialize automatic launches so two chat tabs cannot both decide that the
// same free memory is available. Existing ready servers bypass this queue.
let startupQueue: Promise<unknown> = Promise.resolve();

export async function ensureChatRun(threadKey: string, permission: ReleasePermission, signal: AbortSignal, stage: (value: StartupStage) => void): Promise<ChatRun> {
  const conversation = useChatStore.getState().conversations[threadKey];
  if (conversation?.target.provider !== 'local') throw new Error('unavailable');
  const target = conversation.target;
  const initialState = useControlStore.getState();
  const initial = initialState.runs.find(run => sameChatTarget(target, chatRunTarget(run)));
  if (!initial) throw new Error('changed');
  if (ready(initial)) return initial;
  if (!canStartChatRun(initial)) throw new Error('unavailable');
  const launchFingerprint = fingerprint(initialState, initial);
  const assertTarget = () => {
    checkAbort(signal);
    const state = useControlStore.getState(), run = state.runs.find(item => item.info.runId === target.runId);
    if (!run || !sameChatTarget(useChatStore.getState().conversations[threadKey]?.target ?? target, target)
      || fingerprint(state, run) !== launchFingerprint) throw new Error('changed');
    return run;
  };
  const operation = startupQueue.catch(() => undefined).then(async () => {
    let run = assertTarget();
    if (ready(run)) {
      // A queued operation may have started this exact saved server already.
      if (!sameChatTarget(target, chatRunTarget(run))) throw new Error('changed');
      return run;
    }
    if (['stopped', 'crashed'].includes(run.info.state)) {
      if (useControlStore.getState().optimizerRunning) throw new Error('startupBusy');
      stage('checking');
      if (bridge.isTauri()) {
        const request = await bridge.createRunStartRequest(launchInput(useControlStore.getState(), run));
        for (let attempt = 0; ; attempt++) {
          checkAbort(signal);
          await useControlStore.getState().refreshManagedRuns();
          const plan = await invoke<NativeResourcePlan>('plan_run_resources', { request });
          run = assertTarget();
          if (plan.contractVersion !== 1 || !Array.isArray(plan.candidates)) throw new Error('memoryCheckFailed');
          const proposed = memoryReleaseProposal(run, useControlStore.getState().runs, plan);
          if (!proposed.length) {
            if (plan.candidates.find(item => item.id === 'configured')?.status === 'insufficient') throw new Error('startupMemory');
            break;
          }
          if (attempt >= 8) throw new Error('startupMemory');
          if (!await permission(proposed)) throw cancelled();
          assertTarget();
          for (const approved of proposed) {
            const current = useControlStore.getState().runs.find(item => item.info.runId === approved.info.runId);
            if (!current || !sameChatTarget(chatRunTarget(current), chatRunTarget(approved))) throw new Error('changed');
            stage('stopping');
            await useControlStore.getState().stopManagedRun(current.info.runId);
            checkAbort(signal);
            const stopped = useControlStore.getState().runs.find(item => item.info.runId === current.info.runId);
            if (stopped?.info.state !== 'stopped') throw new Error(stopped?.info.lastError || 'startupStopFailed');
          }
          stage('checking');
        }
      }
      assertTarget();
      stage('starting');
      await useControlStore.getState().startManagedRun(target.runId);
      run = useControlStore.getState().runs.find(item => item.info.runId === target.runId)!;
      if (!run || ['stopped', 'crashed'].includes(run.info.state)) throw new Error(run?.info.lastError || useControlStore.getState().error || 'unavailable');
      // Rebind only after this operation starts the captured saved profile.
      useChatStore.setState(state => {
        const current = state.conversations[threadKey];
        return current && sameChatTarget(current.target, target) ? { conversations: { ...state.conversations,
          [threadKey]: { ...current, target: chatRunTarget(run), updatedAt: Date.now() } } } : state;
      });
    }
    return waitReady(target.runId, run.info.generation, signal, stage);
  });
  startupQueue = operation.catch(() => undefined);
  return new Promise<ChatRun>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
