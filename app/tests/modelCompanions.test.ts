import { describe, expect, it } from 'vitest';
import { modelCompanions } from '../src/lib/modelCompanions';
import type { ArtifactCatalog } from '../src/services/modelFiles';

const file = (path: string, state: 'complete' | 'incomplete' = 'complete') => ({ path, role: 'primary', state, sizeBytes: 1 });

describe('model companions', () => {
  it('finds the projector and draft model kept in the model folder', () => {
    const catalog: ArtifactCatalog = { artifacts: [
      { id: 'a', kind: 'primaryModel', dependencyIds: [], files: [file('C:/m/qwen/q-00001-of-00002.gguf'), file('C:/m/qwen/q-00002-of-00002.gguf')] },
      { id: 'b', kind: 'mmproj', dependencyIds: [], files: [file('C:/m/qwen/q-mmproj.gguf')] },
      { id: 'c', kind: 'mtp', dependencyIds: [], files: [file('C:/m/qwen/q-mtp.gguf', 'incomplete')] },
    ] };
    expect(modelCompanions(catalog, 'C:\\m\\qwen\\q-00001-of-00002.gguf')).toEqual([
      { kind: 'mmproj', path: 'C:/m/qwen/q-mmproj.gguf', installed: true },
      { kind: 'mtp', path: 'C:/m/qwen/q-mtp.gguf', installed: false },
    ]);
  });

  it('does not hand loose files in a shared folder to one model unless a profile links them', () => {
    const catalog: ArtifactCatalog = { artifacts: [
      { id: 'a', kind: 'primaryModel', dependencyIds: [], files: [file('C:/m/a.gguf')] },
      { id: 'b', kind: 'primaryModel', dependencyIds: [], files: [file('C:/m/b.gguf')] },
      { id: 'p', kind: 'mmproj', dependencyIds: ['b'], files: [file('C:/m/vision-mmproj.gguf')] },
    ] };
    expect(modelCompanions(catalog, 'C:/m/a.gguf')).toEqual([]);
    expect(modelCompanions(catalog, 'C:/m/b.gguf').map(item => item.kind)).toEqual(['mmproj']);
  });

  it('finds the shared projector Strata keeps above the quantization folders by its family name', () => {
    const catalog: ArtifactCatalog = { artifacts: [
      { id: 'a', kind: 'primaryModel', dependencyIds: [], files: [file('C:/m/strata/models/Repo/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf')] },
      { id: 'b', kind: 'primaryModel', dependencyIds: [], files: [file('C:/m/strata/models/other/Gemma-4-12B.gguf')] },
      { id: 'p', kind: 'mmproj', dependencyIds: [], files: [file('C:/m/strata/models/mmproj-Qwen3.8-Flash-Next-BF16.gguf')] },
    ] };
    expect(modelCompanions(catalog, 'C:/m/strata/models/Repo/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf')).toEqual([
      { kind: 'mmproj', path: 'C:/m/strata/models/mmproj-Qwen3.8-Flash-Next-BF16.gguf', installed: true },
    ]);
    expect(modelCompanions(catalog, 'C:/m/strata/models/other/Gemma-4-12B.gguf')).toEqual([]);
  });
});
