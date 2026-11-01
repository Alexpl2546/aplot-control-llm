// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n';
import type { ArtifactCatalog } from '../src/services/modelFiles';
import type { DownloadTask } from '../src/features/modelDownloads/types';
const files = vi.hoisted(() => ({ modelArtifactCatalog: vi.fn(), modelRemovalPlan: vi.fn(), removeModel: vi.fn() }));
vi.mock('../src/services/modelFiles', () => files);
vi.mock('../src/features/modelDownloads/DownloadModelDialog', () => ({ DownloadModelDialog: () => null }));
import { ModelsView } from '../src/views/ModelsView';
import { useControlStore } from '../src/store/control';
import { useModelDownloadStore } from '../src/features/modelDownloads/store';

const modelPath = 'C:/Aplot/models/strata/models/Repo/IQ3_S/Qwen3.8-Flash-Next-IQ3_S.gguf';
const projectorPath = '\\\\?\\C:\\Aplot\\models\\strata\\models\\Repo\\IQ3_S\\aplot-vision-download\\mmproj-Qwen3.8-Flash-Next-BF16.gguf';
const catalog: ArtifactCatalog = { artifacts: [{ id: 'model', kind: 'primaryModel', dependencyIds: [], files: [{ path: modelPath, state: 'complete', role: 'primary', sizeBytes: 100 }] }] };
const completed: DownloadTask = {
  id: 'vision', sequence: 3, state: 'completed', downloadedBytes: 10, totalBytes: 10, speedBytesPerSecond: 0, createdAt: '2026-11-02', updatedAt: '2026-11-02',
  plan: { planId: 'vision', source: 'owner/model', repoId: 'owner/model', revision: 'main', files: [], destination: 'C:/Aplot/models', finalPath: 'C:/Aplot/models/vision', totalBytes: 10, availableBytes: 100, warnings: [] },
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  useControlStore.setState({ libraryModels: [{ id: 'model', name: 'Qwen3.8-Flash-Next', path: modelPath, sizeBytes: 100, sources: {} }], libraryErrors: [], profiles: [] });
  useModelDownloadStore.setState({ tasks: [] });
  files.modelArtifactCatalog.mockResolvedValue(catalog);
});
afterEach(cleanup);

it('recognizes a completed projector without opening Downloads or rescanning the model list', async () => {
  render(<ModelsView/>);
  await waitFor(() => expect(files.modelArtifactCatalog).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: i18n.t('models.files.download') })).toBeTruthy();
  const unchangedModels = useControlStore.getState().libraryModels;
  files.modelArtifactCatalog.mockResolvedValue({ artifacts: [...catalog.artifacts, {
    id: 'projector', kind: 'mmproj', dependencyIds: [], files: [{ path: projectorPath, state: 'complete', role: 'mmproj', sizeBytes: 10 }],
  }] });
  act(() => useModelDownloadStore.getState().applyTask(completed));
  await waitFor(() => expect(screen.getByText(i18n.t('models.files.installed'))).toBeTruthy());
  expect(screen.queryByRole('button', { name: i18n.t('models.files.download') })).toBeNull();
  expect(useControlStore.getState().libraryModels).toBe(unchangedModels);
  expect(files.modelArtifactCatalog).toHaveBeenCalledTimes(2);
  act(() => useModelDownloadStore.getState().applyTask({ ...completed, id: 'next', sequence: 1, state: 'downloading' }));
  expect(files.modelArtifactCatalog).toHaveBeenCalledTimes(2);
});
