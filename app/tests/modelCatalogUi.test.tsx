// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadSearchResult, DownloadSearchPage } from '../src/features/modelDownloads/types';

const mocks = vi.hoisted(() => {
  const hardware = { ramGiB: 4, freeRamGiB: 2, vramGiB: 0 };
  const catalog = [
    { id: 'strata-small', name: 'Small Strata model', engine: 'strata', ramGiB: 1, vramGiB: 0, downloadGiB: 1, use: 'chat' },
    { id: 'strata-large', name: 'Large Strata model', engine: 'strata', ramGiB: 80, vramGiB: 6, downloadGiB: 128, use: 'chat' },
    { id: 'strata-own-path', name: 'Qwen3.6 own-path model', engine: 'strata', ramGiB: 44, vramGiB: 6, downloadGiB: 33, use: 'coding' },
    { id: 'strata-deepseek41-ist-das-2.00bpw', name: 'DeepSeek V4.1 Flash · IST-DAS-2.00bpw', family: 'deepseek41', model: 'IST-DAS-2.00bpw', configTag: 'deepseek-v4.1-flash-ist-das-2.00bpw', source: 'ISTA-DASLab/DeepSeek-V4.1-Flash-GGUF', engine: 'strata', ramGiB: 1, vramGiB: 0, downloadGiB: 10, use: 'chat' },
    { id: 'llama-small', name: 'Small llama.cpp recipe', engine: 'llama_cpp', ramGiB: 1, vramGiB: 0, downloadGiB: 1, use: 'chat' },
  ];
  return {
    hardware, catalog,
    control: { availableEngines: ['strata', 'llama_cpp'], settings: { strataRootPath: 'C:/Engines/Strata' } },
    acquisition: { busy: false, preparation: undefined },
    load: vi.fn(), begin: vi.fn(), search: vi.fn(), pickDirectory: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/features/agent/WorkspacePanels', () => ({
  WorkspaceDialog: ({ title, children }: { title: string; children: ReactNode }) => <section role="dialog" aria-label={title}>{children}</section>,
}));
vi.mock('../src/store/control', () => ({ useControlStore: (selector: (state: typeof mocks.control) => unknown) => selector(mocks.control) }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));
vi.mock('../src/services/dialog', () => ({ pickDirectory: mocks.pickDirectory }));
vi.mock('../src/services/settingsWindow', () => ({ openSettingsSection: vi.fn() }));
vi.mock('../src/features/modelDownloads/recipes', () => ({
  MODEL_RECIPES: [], loadModelRecipes: mocks.load,
  recipeFits: (recipe: { ramGiB: number; vramGiB: number }, hardware: typeof mocks.hardware) => recipe.ramGiB <= hardware.ramGiB && recipe.vramGiB <= hardware.vramGiB,
}));
vi.mock('../src/features/modelDownloads/acquisition', () => ({
  beginModelRecipe: mocks.begin,
  currentRecipeHardware: () => mocks.hardware,
  readRecipeHardware: async () => mocks.hardware,
  useAcquisitionStore: (selector: (state: typeof mocks.acquisition) => unknown) => selector(mocks.acquisition),
}));
vi.mock('../src/features/modelDownloads/service', () => ({
  modelDownloadDestination: async (engine: string) => `C:/Aplot/models/${engine === 'strata' ? 'strata' : 'llama'}`, searchModelDownloads: mocks.search,
}));

import { ModelCatalogDialog } from '../src/features/modelDownloads/ModelCatalogDialog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function repository(repoId: string, gated = false): DownloadSearchResult {
  return { repoId, publisher: repoId.split('/')[0], repositoryUrl: `https://huggingface.co/${repoId}`, downloads: 123, likes: 4, tags: ['gguf'], gated };
}

async function flush(milliseconds = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

function chooseFilterOption(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function show(initialEngine: 'strata' | 'llama_cpp' = 'strata') {
  const callbacks = { onClose: vi.fn(), onAdvanced: vi.fn(), onQueued: vi.fn() };
  render(<ModelCatalogDialog {...callbacks} initialEngine={initialEngine}/>);
  return callbacks;
}

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(mocks.catalog);
  mocks.begin.mockResolvedValue(undefined);
  mocks.search.mockResolvedValue({ items: [], nextCursor: null });
  mocks.pickDirectory.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('model acquisition catalog', () => {
  it('shows every installed Strata option on a low-memory machine until fit filtering is requested', async () => {
    show();
    await flush();
    expect(mocks.load).toHaveBeenCalledWith('C:/Engines/Strata');
    for (const name of ['Small Strata model', 'Large Strata model', 'Qwen3.6 own-path model']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('heading', { name: 'Small llama.cpp recipe' })).toBeNull();
    expect((screen.getByLabelText('recipes.onlyFit') as HTMLInputElement).checked).toBe(false);
    const largeCard = screen.getByRole('heading', { name: 'Large Strata model' }).closest('article')!;
    expect(within(largeCard).getByRole('button', { name: 'recipes.install' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByLabelText('recipes.onlyFit'));
    expect(screen.getByRole('heading', { name: 'Small Strata model' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Large Strata model' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Qwen3.6 own-path model' })).toBeNull();

    fireEvent.click(screen.getByLabelText('recipes.onlyFit'));
    expect(screen.getByRole('heading', { name: 'Qwen3.6 own-path model' })).toBeTruthy();
  });

  it('passes the selected folder to Strata preparation and closes only after it has been queued', async () => {
    const queued = deferred<void>();
    mocks.begin.mockReturnValue(queued.promise);
    mocks.pickDirectory.mockResolvedValue('D:/Model Library');
    const callbacks = show();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'downloads.chooseDestination' }));
    await flush();
    expect((screen.getByRole('textbox', { name: 'downloads.destination' }) as HTMLInputElement).value).toBe('D:/Model Library');
    const card = screen.getByRole('heading', { name: 'Qwen3.6 own-path model' }).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'recipes.install' }));
    expect(mocks.begin).toHaveBeenCalledWith('strata-own-path', 'D:/Model Library');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onQueued).not.toHaveBeenCalled();

    await act(async () => queued.resolve());
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(callbacks.onQueued).toHaveBeenCalledTimes(1);
  });

  it('keeps the installation dialog open when preparation fails', async () => {
    mocks.begin.mockRejectedValue(new Error('model preparation failed'));
    const callbacks = show();
    await flush();
    const card = screen.getByRole('heading', { name: 'Small Strata model' }).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'recipes.install' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('model preparation failed');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onQueued).not.toHaveBeenCalled();
  });

  it('filters Strata recipes by family while keeping DeepSeek available from the installed catalog', async () => {
    show();
    await flush();
    expect(screen.getByRole('heading', { name: 'DeepSeek V4.1 Flash' })).toBeTruthy();
    fireEvent.click(screen.getByText('downloads.filters'));
    chooseFilterOption('downloads.family', 'DeepSeek');
    expect(screen.getByRole('heading', { name: 'DeepSeek V4.1 Flash' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Qwen3.6 own-path model' })).toBeNull();
  });
});

describe('Hugging Face catalog search', () => {
  it('uses separate engine folders and retains an edited folder when switching back', async () => {
    show('llama_cpp');
    await flush();
    expect((screen.getByRole('textbox', { name: 'downloads.destination' }) as HTMLInputElement).value).toBe('C:/Aplot/models/llama');
    fireEvent.change(screen.getByRole('textbox', { name: 'downloads.destination' }), { target: { value: 'D:/Custom llama' } });
    fireEvent.click(screen.getByRole('button', { name: 'Strata', exact: true }));
    await flush();
    expect((screen.getByRole('textbox', { name: 'downloads.destination' }) as HTMLInputElement).value).toBe('C:/Aplot/models/strata');
    fireEvent.click(screen.getByRole('button', { name: 'llama.cpp', exact: true }));
    await flush();
    expect((screen.getByRole('textbox', { name: 'downloads.destination' }) as HTMLInputElement).value).toBe('D:/Custom llama');
  });

  it('shows model metadata and appends the next Hub page without duplicate repositories', async () => {
    const first = { ...repository('author/Model-GGUF'), parameterCount: 8e9, contextLength: 131072, sizeBytes: 4 * 2 ** 30, architecture: 'llama', license: 'apache-2.0' };
    mocks.search.mockResolvedValueOnce({ items: [first], nextCursor: 'page-two' }).mockResolvedValueOnce({ items: [first, repository('author/Other-GGUF')], nextCursor: null });
    show('llama_cpp'); await flush();
    expect(screen.getByText('8B')).toBeTruthy();
    expect(screen.getByText('128K')).toBeTruthy();
    expect(screen.getByText('apache-2.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'downloads.loadMore' })); await flush();
    expect(mocks.search).toHaveBeenLastCalledWith('', { sort: 'downloads', allGguf: false, cursor: 'page-two' });
    expect(screen.getAllByText('author/Model-GGUF')).toHaveLength(1);
    expect(screen.getByText('author/Other-GGUF')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'downloads.loadMore' })).toBeNull();
  });

  it('uses a selected family to search Hugging Face and filters the returned models', async () => {
    mocks.search.mockResolvedValue({ items: [repository('deepseek-ai/DeepSeek-V4.1-Flash-GGUF'), repository('Qwen/Qwen3.8-GGUF')], nextCursor: null });
    show('llama_cpp');
    await flush();
    fireEvent.click(screen.getByText('downloads.filters'));
    chooseFilterOption('downloads.family', 'DeepSeek');
    await flush(350);
    expect(mocks.search).toHaveBeenLastCalledWith('DeepSeek', { sort: 'downloads', allGguf: false });
    expect(screen.getByText('deepseek-ai/DeepSeek-V4.1-Flash-GGUF')).toBeTruthy();
    expect(screen.queryByText('Qwen/Qwen3.8-GGUF')).toBeNull();
  });

  it('ignores a slower response for an earlier query', async () => {
    const earlier = deferred<DownloadSearchPage>();
    const current = deferred<DownloadSearchPage>();
    mocks.search.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(current.promise);
    show('llama_cpp');
    await flush();
    expect(mocks.search).toHaveBeenCalledWith('', { sort: 'downloads', allGguf: false });

    fireEvent.change(screen.getByRole('textbox', { name: 'downloads.hubQuery' }), { target: { value: 'Qwen' } });
    await flush(349);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(mocks.search).toHaveBeenCalledWith('Qwen', { sort: 'downloads', allGguf: false });
    await act(async () => current.resolve({ items: [repository('current/Qwen-GGUF')], nextCursor: null }));
    expect(screen.getByText('current/Qwen-GGUF')).toBeTruthy();
    await act(async () => earlier.resolve({ items: [repository('stale/Previous-GGUF')], nextCursor: null }));
    expect(screen.queryByText('stale/Previous-GGUF')).toBeNull();
    expect(screen.getByText('current/Qwen-GGUF')).toBeTruthy();
  });

  it('ignores a response from before switching the engine even after returning to llama.cpp', async () => {
    const earlier = deferred<DownloadSearchPage>();
    const current = deferred<DownloadSearchPage>();
    mocks.search.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(current.promise);
    show('llama_cpp');
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Strata', exact: true }));
    expect(screen.queryByRole('textbox', { name: 'downloads.hubQuery' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'llama.cpp', exact: true }));
    await flush();
    expect(mocks.search).toHaveBeenCalledTimes(2);

    await act(async () => current.resolve({ items: [repository('current/Engine-GGUF')], nextCursor: null }));
    await act(async () => earlier.resolve({ items: [repository('stale/Engine-GGUF')], nextCursor: null }));
    expect(screen.getByText('current/Engine-GGUF')).toBeTruthy();
    expect(screen.queryByText('stale/Engine-GGUF')).toBeNull();
  });

  it('opens the selected repository with the edited destination and disables gated downloads', async () => {
    mocks.search.mockResolvedValue({ items: [repository('publisher/Compatible-GGUF'), repository('publisher/Gated-GGUF', true)], nextCursor: null });
    const callbacks = show('llama_cpp');
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'downloads.destination' }), { target: { value: '  E:/Selected Models  ' } });
    const gated = screen.getByText('publisher/Gated-GGUF').closest('article')!;
    expect(within(gated).getByRole('button', { name: 'downloads.hubGated' }).hasAttribute('disabled')).toBe(true);
    const selected = screen.getByText('publisher/Compatible-GGUF').closest('article')!;
    fireEvent.click(within(selected).getByText('downloads.details'));
    expect(within(selected).getByRole('link').getAttribute('href')).toBe('https://huggingface.co/publisher/Compatible-GGUF');
    fireEvent.click(within(selected).getByRole('button', { name: 'downloads.chooseVariant' }));
    expect(callbacks.onAdvanced).toHaveBeenCalledWith('publisher/Compatible-GGUF', 'E:/Selected Models');
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
