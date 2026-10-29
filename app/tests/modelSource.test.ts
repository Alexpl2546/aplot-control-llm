import { describe, expect, it } from 'vitest';
import { modelFolder, modelSourceRepo } from '../src/lib/modelSource';
import type { EngineModel } from '../src/lib/engineModels';

const model = (path: string, metadata?: Record<string, string>): EngineModel => ({
  id: path, name: 'm', path, sizeBytes: 1,
  sources: metadata ? { llama_cpp: { id: path, name: 'm', path, sizeBytes: 1, metadata } as never } : {},
});

describe('model source repository', () => {
  it('reads the source tag the GGUF carries', () => {
    expect(modelSourceRepo(model('C:/m/x.gguf', { 'general.source.url': 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF' }), [])).toBe('unsloth/gemma-4-12b-it-GGUF');
  });

  it('recognises the folder the downloader named after the repository', () => {
    const path = 'C:/Aplot/models/strata/models/ISTA-DASLab-Qwen3.8-Flash-Next-GSQ-RCO-GGUF-3a7ffebf-a2e8-4fbf-b3db-8dea574b455b/IQ3_S/Qwen3.8-IQ3_S-00001-of-00002.gguf';
    expect(modelSourceRepo(model(path), ['Qwen/Qwen3-4B-GGUF', 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF'])).toBe('ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF');
    expect(modelSourceRepo(model('C:/models/loose.gguf'), ['Qwen/Qwen3-4B-GGUF'])).toBe('');
    expect(modelFolder(model(path))).toMatch(/IQ3_S$/);
  });
});
