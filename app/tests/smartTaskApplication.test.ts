import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import * as bridge from '../src/services/tauri';
import { createTaskProfile, TaskApplicationError } from '../src/features/smartTasks/application';
import { DEFAULT_CAPABILITIES, DEFAULT_CONFIG } from '../src/types/config';
import { DEFAULT_SETTINGS, type LaunchProfile } from '../src/types/app';
import { planTask, taskCandidates } from '../src/features/smartTasks/planner';
import { presetDraft } from '../src/features/smartTasks/presets';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/services/tauri', () => ({ isTauri: vi.fn(), duplicateProfileSnapshot: vi.fn(), saveProfile: vi.fn(), deleteProfile: vi.fn(), createRunStartRequest: vi.fn() }));

function fixture(engine: string) {
  const source: LaunchProfile = { id: 'source', name: 'Source', config: { ...structuredClone(DEFAULT_CONFIG), engine, profileId: 'source', profileName: 'Source', ctxSize: 65536, parallel: 1, modelPath: 'model.gguf', extraArgs: '--spec-type none --no-cache-prompt', engineOptions: { strata: { strataRootPath: 'C:/Strata', strataConfigPath: 'C:/Strata/strata-source.json' }, futureEngine: { retained: true } } }, createdAt: 'before', updatedAt: 'before', revision: 4, lastKnownGood: true };
  const models = [{ configPath: 'C:/Strata/strata-source.json', modelName: 'Source', contextLength: 65536 }];
  const config = planTask(presetDraft('coding'), taskCandidates([source], models)).config!;
  return { source, config };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(bridge.isTauri).mockReturnValue(true);
  vi.mocked(bridge.createRunStartRequest).mockResolvedValue({ runId: 'new', name: 'Task', engine: 'strata', contextTokens: 32768, mode: 'single', modelId: 'model', launch: {} });
  vi.mocked(bridge.saveProfile).mockImplementation(async p => p);
  vi.mocked(bridge.deleteProfile).mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async command => command === 'create_strata_task_config' ? 'C:/Strata/strata-task-new.json' : command === 'plan_run_resources' ? { candidates: [{ id: 'configured', status: 'unknown' }] } : undefined);
});
describe('task profile application boundary', () => {
  it('creates a separate Strata config and profile without altering the source', async () => {
    const { source, config } = fixture('strata');
    const before = structuredClone(source);
    const result = await createTaskProfile(source, config, DEFAULT_SETTINGS, DEFAULT_CAPABILITIES, 'Task');
    expect(result.profile.id).not.toBe(source.id);
    expect(result.profile.config.engineOptions?.strata?.strataConfigPath).toBe('C:/Strata/strata-task-new.json');
    expect(result.profile.lastKnownGood).toBe(false);
    expect(result.profile.config.extraArgs).toBe(source.config.extraArgs);
    expect(source).toEqual(before);
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(['create_strata_task_config', 'plan_run_resources']);
    expect(vi.mocked(bridge.saveProfile).mock.calls[0][0].id).not.toBe('source');
  });
  it('cleans a generated config and refuses to save when the exact resource plan is insufficient', async () => {
    const { source, config } = fixture('strata');
    vi.mocked(invoke).mockImplementation(async command => command === 'create_strata_task_config' ? 'task.json' : command === 'plan_run_resources' ? { candidates: [{ id: 'configured', status: 'insufficient' }] } : undefined);
    await expect(createTaskProfile(source, config, DEFAULT_SETTINGS, DEFAULT_CAPABILITIES, 'Task')).rejects.toBeInstanceOf(TaskApplicationError);
    expect(bridge.saveProfile).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('remove_strata_task_config', expect.any(Object));
  });
  it('refuses to derive a task profile from an unsupported legacy engine', async () => {
    const { source, config } = fixture('strata');
    source.config.engine = 'infernix';
    source.unsupportedEngine = 'infernix';
    await expect(createTaskProfile(source, config, DEFAULT_SETTINGS, DEFAULT_CAPABILITIES, 'Task')).rejects.toBeInstanceOf(TaskApplicationError);
    expect(bridge.saveProfile).not.toHaveBeenCalled();
  });
  it('previews the new llama.cpp router identity rather than an absent source route', async () => {
    const actual = await vi.importActual<typeof bridge>('../src/services/tauri');
    vi.mocked(bridge.createRunStartRequest).mockImplementation(actual.createRunStartRequest);
    const { source, config } = fixture('llama_cpp');
    const result = await createTaskProfile(source, config, { ...DEFAULT_SETTINGS, serverMode: 'router' }, { ...DEFAULT_CAPABILITIES, modelsRouter: true }, 'New task route');
    expect(result.profile.name).toBe('New task route');
    const input = vi.mocked(bridge.createRunStartRequest).mock.calls[0][0];
    expect(input.profiles[0].id).toBe(input.config.profileId);
    expect(input.profiles[0].config.ctxSize).toBe(config.ctxSize);
  });
  it('rolls back the duplicate and derived file when profile persistence fails', async () => {
    const { source, config } = fixture('strata');
    source.v2 = { id: source.id } as NonNullable<LaunchProfile['v2']>;
    vi.mocked(bridge.duplicateProfileSnapshot).mockImplementation(async (_, id, name) => ({ ...source, id, name, revision: 1 }));
    vi.mocked(bridge.saveProfile).mockRejectedValue(new Error('revision conflict'));
    await expect(createTaskProfile(source, config, DEFAULT_SETTINGS, DEFAULT_CAPABILITIES, 'Task')).rejects.toThrow('revision conflict');
    expect(bridge.deleteProfile).toHaveBeenCalledWith(expect.not.stringMatching(/^source$/), 1);
    expect(invoke).toHaveBeenCalledWith('remove_strata_task_config', expect.any(Object));
  });
});
