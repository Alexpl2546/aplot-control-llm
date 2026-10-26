import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridge from '../src/services/tauri';
import { useControlStore } from '../src/store/control';
import { DEFAULT_SETTINGS } from '../src/types/app';
import { DEFAULT_CONFIG } from '../src/types/config';
import { modelConfigurationEngine, type EngineModel } from '../src/lib/engineModels';

afterEach(() => vi.restoreAllMocks());

describe('optional engine availability', () => {
  async function initialize(installed: bridge.EngineInstallation[], settingsPatch: Partial<typeof DEFAULT_SETTINGS> = {}) {
    vi.spyOn(bridge, 'getSettings').mockResolvedValue({ ...DEFAULT_SETTINGS, setupCompleted: true, routerApiKey: 'fixture-key', serverEngine: 'llama_cpp', ...settingsPatch });
    vi.spyOn(bridge, 'saveSettings').mockImplementation(async settings => settings);
    vi.spyOn(bridge, 'availableEngines').mockResolvedValue(installed);
    vi.spyOn(bridge, 'listProfiles').mockResolvedValue([]);
    vi.spyOn(bridge, 'listBenchmarks').mockResolvedValue([]);
    vi.spyOn(bridge, 'listBenchmarkSuites').mockResolvedValue([]);
    vi.spyOn(bridge, 'loadLastKnownGood').mockResolvedValue(null);
    vi.spyOn(bridge, 'loadLastKnownGoodRouter').mockResolvedValue(null);
    const current = useControlStore.getState();
    const detectBinary = vi.fn(), loadRuns = vi.fn(), rescanModels = vi.fn(), refreshRuntime = vi.fn();
    useControlStore.setState({ initialized: false, error: undefined, detectBinary, loadRuns, rescanModels, refreshRuntime });
    try { await useControlStore.getState().initialize(); }
    finally { useControlStore.setState({ detectBinary: current.detectBinary, loadRuns: current.loadRuns, rescanModels: current.rescanModels, refreshRuntime: current.refreshRuntime }); }
    return detectBinary;
  }

  it('keeps a migrated engine unselected when Strata is installed and never probes absent llama.cpp', async () => {
    const detect = await initialize([{ id: 'strata', path: 'C:/components/strata', version: 'fixture' }], { serverEngine: '', legacyEngineId: 'qwfnfer' });
    expect(detect).not.toHaveBeenCalled();
    expect(useControlStore.getState().settings.serverEngine).toBe('');
    expect(useControlStore.getState().settings.legacyEngineId).toBe('qwfnfer');
    expect(useControlStore.getState().settings.strataRootPath).toBe('C:/components/strata');
    expect(useControlStore.getState().availableEngines).toEqual(['strata']);
    expect(useControlStore.getState().error).toBeUndefined();
  });

  it('starts without a llama-server error when no engine finished installation', async () => {
    const detect = await initialize([]);
    expect(detect).not.toHaveBeenCalled();
    expect(useControlStore.getState().availableEngines).toEqual([]);
    expect(useControlStore.getState().error).toBeUndefined();
  });

  it('keeps detection for an installed and selected llama.cpp', async () => {
    const detect = await initialize([{ id: 'llama_cpp', path: 'C:/llama-server.exe', version: 'fixture' }]);
    expect(detect).toHaveBeenCalledOnce();
  });

  it('model configuration never falls back to an absent engine', () => {
    const model: EngineModel = { id: 'm', name: 'model', path: 'm.gguf', sizeBytes: 1, sources: { llama_cpp: { id: 'm', path: 'm.gguf', fileName: 'm.gguf', sizeBytes: 1, modifiedAt: '' }, strata: { configPath: 'm.json', modelName: 'model', contextLength: 4096 } } };
    expect(modelConfigurationEngine(model, 'llama_cpp', 'all', ['strata'])).toBe('strata');
    expect(modelConfigurationEngine(model, 'llama_cpp', 'all', [])).toBeUndefined();
    expect(modelConfigurationEngine(model, 'llama_cpp', 'llama_cpp', [])).toBeUndefined();
  });

  it('rejects configuring a model on an unavailable engine', async () => {
    useControlStore.setState({ config: { ...DEFAULT_CONFIG }, availableEngines: [], optimizerRunning: false, error: undefined });
    expect(await useControlStore.getState().selectLibraryModel('missing', 'llama_cpp')).toBe(false);
    expect(useControlStore.getState().error).toBeTruthy();
  });
});
