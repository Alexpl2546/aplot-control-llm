import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_SEARCH_FILTERS, familySearchTerm, hubModelFamily, hubModelFitsMemory, hubSearchQuery,
  matchesHubModel, matchesRecipe, recipeFamily,
} from '../src/features/modelDownloads/modelSearchFilters';
import type { ModelRecipe, RecipeHardware } from '../src/features/modelDownloads/recipes';
import type { DownloadSearchResult } from '../src/features/modelDownloads/types';

const hardware: RecipeHardware = { ramGiB: 32, freeRamGiB: 24, vramGiB: 8 };

function hubModel(overrides: Partial<DownloadSearchResult> = {}): DownloadSearchResult {
  return {
    repoId: 'deepseek-ai/DeepSeek-V4.1-Flash-GGUF', publisher: 'deepseek-ai', repositoryUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-GGUF',
    downloads: 1000, likes: 100, tags: ['gguf', 'tool-use'], pipelineTag: 'text-generation', gated: false,
    sizeBytes: 10 * 2 ** 30, contextLength: 131_072, ...overrides,
  };
}

function recipe(overrides: Partial<ModelRecipe> = {}): ModelRecipe {
  return {
    id: 'strata-deepseek41-ist-das-2.00bpw', name: 'DeepSeek V4.1 Flash · IST-DAS-2.00bpw', engine: 'strata',
    source: 'ISTA-DASLab/DeepSeek-V4.1-Flash-GGUF', family: 'deepseek41', model: 'IST-DAS-2.00bpw', configTag: 'deepseek-v4.1-flash-ist-das-2.00bpw',
    ramGiB: 48, vramGiB: 6, downloadGiB: 30, memoryGiB: 20, use: 'chat', images: false,
    ...overrides,
  };
}

describe('model catalog search filters', () => {
  it('classifies DeepSeek and Strata ids with decimal quantization names', () => {
    expect(hubModelFamily(hubModel())).toBe('deepseek');
    expect(recipeFamily(recipe())).toBe('deepseek');
    expect(matchesRecipe(recipe(), { ...DEFAULT_MODEL_SEARCH_FILTERS, family: 'deepseek' }, hardware)).toBe(true);
  });

  it('estimates Hugging Face memory fit and supports memory filtering', () => {
    const fits = hubModel();
    const tooLarge = hubModel({ sizeBytes: 30 * 2 ** 30 });
    expect(hubModelFitsMemory(fits, hardware)).toBe(true);
    expect(hubModelFitsMemory(tooLarge, hardware)).toBe(false);
    expect(matchesHubModel(fits, { ...DEFAULT_MODEL_SEARCH_FILTERS, onlyFit: true }, hardware)).toBe(true);
    expect(matchesHubModel(tooLarge, { ...DEFAULT_MODEL_SEARCH_FILTERS, onlyFit: true }, hardware)).toBe(false);
  });

  it('filters developer, purpose, tool support, context and access independently', () => {
    const model = hubModel();
    const filtered = {
      ...DEFAULT_MODEL_SEARCH_FILTERS, creator: 'deepseek', purpose: 'chat' as const, toolsOnly: true,
      minimumContext: 131_072 as const, availableOnly: true,
    };
    expect(matchesHubModel(model, filtered, hardware)).toBe(true);
    expect(matchesHubModel(hubModel({ gated: true }), filtered, hardware)).toBe(false);
    expect(matchesHubModel(hubModel({ contextLength: 8192 }), filtered, hardware)).toBe(false);
    expect(matchesHubModel(hubModel({ tags: ['gguf'] }), filtered, hardware)).toBe(false);
  });

  it('treats uncensored as an explicit catalog label instead of a safety claim', () => {
    const marked = hubModel({ repoId: 'author/DeepSeek-Uncensored-GGUF' });
    const filter = { ...DEFAULT_MODEL_SEARCH_FILTERS, uncensored: 'marked' as const };
    expect(matchesHubModel(marked, filter, hardware)).toBe(true);
    expect(matchesHubModel(hubModel(), filter, hardware)).toBe(false);
  });

  it('uses a family as a Hugging Face query so DeepSeek is not limited to popular Qwen results', () => {
    expect(familySearchTerm('deepseek')).toBe('DeepSeek');
    expect(hubSearchQuery('', 'deepseek')).toBe('DeepSeek');
    expect(hubSearchQuery('reasoning', 'deepseek')).toBe('reasoning DeepSeek');
    expect(hubSearchQuery('DeepSeek V4', 'deepseek')).toBe('DeepSeek V4');
  });
});
