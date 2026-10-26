// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineModel } from '../src/lib/engineModels';
import type { ModelInfo } from '../src/types/app';

const mocks = vi.hoisted(() => ({
  control: {
    libraryModels: [] as EngineModel[], availableEngines: ['llama_cpp', 'strata'],
    libraryErrors: [], settings: { favoriteModelIds: [], serverEngine: 'strata' },
    profiles: [], busy: false, optimizerRunning: false,
    selectLibraryModel: vi.fn(), setView: vi.fn(), notify: vi.fn(), updateSettings: vi.fn(),
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/store/control', () => ({
  useControlStore: (selector?: (state: typeof mocks.control) => unknown) => selector ? selector(mocks.control) : mocks.control,
}));
vi.mock('../src/services/desktop', () => ({ revealItem: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock('../src/components/feedback/FriendlyInlineError', () => ({ FriendlyInlineError: () => null }));

import { buildEngineModels } from '../src/lib/engineModels';
import { ModelsView } from '../src/views/ModelsView';

const downloaded: ModelInfo = {
  id: 'qwen', path: 'C:/Models/Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf',
  fileName: 'Qwen3.8-Flash-Next-IQ3_S-00001-of-00002.gguf', modelName: 'Qwen3.8 Flash Next',
  sizeBytes: 100, modifiedAt: '', architecture: 'qwen4exp', quantization: 'IQ3_S',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.control.selectLibraryModel.mockResolvedValue(true);
  mocks.control.libraryModels = buildEngineModels([downloaded], []);
});
afterEach(cleanup);

describe('downloaded Strata model readiness', () => {
  it('keeps unfinished Strata models visible in the Strata list and offers preparation without a ready engine badge', () => {
    const prepare = vi.fn();
    render(<ModelsView embedded engineFilter="strata" onPrepareStrata={prepare}/>);
    expect(screen.getByRole('heading', { name: downloaded.modelName })).toBeTruthy();
    expect(screen.getByText('models.strataPreparationRequired')).toBeTruthy();
    expect(screen.getByText('models.strataPreparationHint')).toBeTruthy();
    expect(screen.queryByText('Strata')).toBeNull();
    const action = screen.getByRole('button', { name: 'models.prepareStrata' });
    expect(action.hasAttribute('disabled')).toBe(false);
    fireEvent.click(action);
    expect(prepare).toHaveBeenCalledOnce();
    expect(mocks.control.selectLibraryModel).not.toHaveBeenCalled();
  });

  it('switches to the normal Strata configuration action after a validated config is discovered', async () => {
    mocks.control.libraryModels = buildEngineModels([downloaded], [{
      configPath: 'C:/Strata/strata-qwen.json', modelPath: downloaded.path,
      modelName: 'Qwen', contextLength: 8192,
    }]);
    const prepare = vi.fn();
    render(<ModelsView embedded engineFilter="strata" onPrepareStrata={prepare}/>);
    expect(screen.getByText('Strata')).toBeTruthy();
    expect(screen.queryByText('models.strataPreparationRequired')).toBeNull();
    expect(screen.queryByRole('button', { name: 'models.prepareStrata' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'models.configureModel' }));
    await waitFor(() => expect(mocks.control.selectLibraryModel).toHaveBeenCalledWith('qwen', 'strata'));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not advertise Strata preparation for an unrelated GGUF', () => {
    mocks.control.libraryModels = buildEngineModels([{ ...downloaded, architecture: 'qwen2' }], []);
    render(<ModelsView embedded engineFilter="strata" onPrepareStrata={vi.fn()}/>);
    expect(screen.queryByRole('heading', { name: downloaded.modelName })).toBeNull();
    expect(screen.queryByRole('button', { name: 'models.prepareStrata' })).toBeNull();
  });
});
