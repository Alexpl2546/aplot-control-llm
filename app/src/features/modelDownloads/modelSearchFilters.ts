import { modelCatalog, type ModelUse } from '../../lib/modelCatalog';
import { recipeFits, type ModelRecipe, type RecipeHardware } from './recipes';
import type { DownloadSearchResult } from './types';

export type ModelFamily = 'all' | 'qwen' | 'deepseek' | 'llama' | 'gemma' | 'mistral' | 'phi' | 'gpt_oss' | 'other';
export type SearchPurpose = ModelUse | 'embeddings';
export type UncensoredFilter = 'all' | 'marked' | 'unmarked';

export interface ModelSearchFilters {
  family: ModelFamily;
  creator: string;
  purpose: SearchPurpose | 'all';
  uncensored: UncensoredFilter;
  toolsOnly: boolean;
  visionOnly: boolean;
  onlyFit: boolean;
  availableOnly: boolean;
  minimumContext: 0 | 32_768 | 131_072;
}

export const DEFAULT_MODEL_SEARCH_FILTERS: ModelSearchFilters = {
  family: 'all', creator: '', purpose: 'all', uncensored: 'all',
  toolsOnly: false, visionOnly: false, onlyFit: false, availableOnly: false, minimumContext: 0,
};

const families: Array<[Exclude<ModelFamily, 'all' | 'other'>, RegExp]> = [
  ['qwen', /qwen/i], ['deepseek', /deepseek/i], ['llama', /llama/i], ['gemma', /gemma/i],
  ['mistral', /mistral|mixtral/i], ['phi', /(?:^|[^a-z])phi(?:[^a-z]|$)/i], ['gpt_oss', /gpt[\s._-]*oss/i],
];

function familyOf(identity: string): Exclude<ModelFamily, 'all'> {
  return families.find(([, pattern]) => pattern.test(identity))?.[0] ?? 'other';
}

export function hubModelFamily(model: DownloadSearchResult): Exclude<ModelFamily, 'all'> {
  return familyOf(`${model.repoId} ${model.baseModel ?? ''} ${model.architecture ?? ''}`);
}

export function recipeFamily(recipe: ModelRecipe): Exclude<ModelFamily, 'all'> {
  return familyOf(`${recipe.name} ${recipe.family ?? ''} ${recipe.model ?? ''} ${recipe.source ?? ''}`);
}

function modelCatalogEntry(name: string, path: string, architecture?: string) {
  return modelCatalog({ name, path, architecture });
}

export function hubModelPurposes(model: DownloadSearchResult): SearchPurpose[] {
  const identity = `${model.repoId} ${model.baseModel ?? ''} ${model.tags.join(' ')} ${model.description ?? ''}`;
  const catalog = modelCatalogEntry(model.repoId, model.repoId, model.architecture);
  const purposes = new Set<SearchPurpose>(catalog?.uses ?? []);
  const pipeline = model.pipelineTag?.toLowerCase() ?? '';
  if (/feature-extraction|sentence-similarity|text-embedding/.test(pipeline) || /embedding|\bbge[-_ ]|\be5[-_ ]|\bgte[-_ ]/i.test(identity)) purposes.add('embeddings');
  if (/text-generation|conversational/.test(pipeline) || /\b(instruct|chat|assistant)\b/i.test(identity)) purposes.add('chat');
  if (/\b(coder|coding|code[-_ ](llm|model)|programming)\b/i.test(identity)) purposes.add('coding');
  if (/\b(agent|tool[-_ ]use|function[-_ ]calling)\b/i.test(identity)) purposes.add('agents');
  if (/\b(reasoning|reasoner|thinking|analysis)\b/i.test(identity)) purposes.add('analysis');
  if (/summarization|question-answering|document|long-context/.test(pipeline) || /\b(document|long[-_ ]context)\b/i.test(identity)) purposes.add('documents');
  if (/text-to-image|image-generation|creative/.test(pipeline) || /\b(creative|roleplay|story)\b/i.test(identity)) purposes.add('creative');
  return [...purposes];
}

export function recipePurposes(recipe: ModelRecipe): SearchPurpose[] {
  const catalog = modelCatalogEntry(recipe.name, recipe.source ?? recipe.name);
  return [...new Set<SearchPurpose>([recipe.use, ...(catalog?.uses ?? [])])];
}

export function hubModelUncensored(model: DownloadSearchResult): boolean {
  return /uncensored|unfiltered|abliterat/i.test(`${model.repoId} ${model.tags.join(' ')} ${model.description ?? ''}`);
}

function recipeUncensored(recipe: ModelRecipe): boolean {
  return /uncensored|unfiltered|abliterat/i.test(`${recipe.name} ${recipe.family ?? ''} ${recipe.source ?? ''} ${recipe.about ?? ''}`);
}

export function hubModelTools(model: DownloadSearchResult): boolean {
  const marked = model.tags.some(tag => /^(tool[-_ ]?use|tool[-_ ]?calling|function[-_ ]?calling|agents?)$/i.test(tag));
  return marked || modelCatalogEntry(model.repoId, model.repoId, model.architecture)?.tools === true;
}

export function recipeTools(recipe: ModelRecipe): boolean {
  return recipe.tools === true || modelCatalogEntry(recipe.name, recipe.source ?? recipe.name)?.tools === true;
}

export function hubModelVision(model: DownloadSearchResult): boolean {
  return model.pipelineTag?.includes('image') === true || model.tags.some(tag => /^(vision|multimodal)$/i.test(tag));
}

function modelMatchesCommonFilters(values: {
  family: Exclude<ModelFamily, 'all'>;
  creator: string;
  purposes: readonly SearchPurpose[];
  uncensored: boolean;
  tools: boolean;
  vision: boolean;
  fits: boolean;
}, filters: ModelSearchFilters) {
  return (filters.family === 'all' || values.family === filters.family)
    && values.creator.toLocaleLowerCase().includes(filters.creator.trim().toLocaleLowerCase())
    && (filters.purpose === 'all' || values.purposes.includes(filters.purpose))
    && (filters.uncensored === 'all' || values.uncensored === (filters.uncensored === 'marked'))
    && (!filters.toolsOnly || values.tools)
    && (!filters.visionOnly || values.vision)
    && (!filters.onlyFit || values.fits);
}

export function hubModelFitsMemory(model: DownloadSearchResult, hardware: RecipeHardware): boolean {
  if (!model.sizeBytes || !Number.isFinite(model.sizeBytes) || !Number.isFinite(hardware.freeRamGiB) || !Number.isFinite(hardware.vramGiB)) return false;
  const availableGiB = Math.max(0, hardware.freeRamGiB) + Math.max(0, hardware.vramGiB - 6);
  // HF reports weight file size, not runtime usage; keep a 20% buffer and label it as an estimate.
  return model.sizeBytes / 2 ** 30 * 1.2 <= availableGiB;
}

export function matchesHubModel(model: DownloadSearchResult, filters: ModelSearchFilters, hardware: RecipeHardware): boolean {
  return modelMatchesCommonFilters({
    family: hubModelFamily(model), creator: model.publisher, purposes: hubModelPurposes(model), uncensored: hubModelUncensored(model),
    tools: hubModelTools(model), vision: hubModelVision(model),
    fits: hubModelFitsMemory(model, hardware),
  }, filters)
    && (!filters.availableOnly || !model.gated)
    && (!filters.minimumContext || (model.contextLength ?? 0) >= filters.minimumContext);
}

export function matchesRecipe(recipe: ModelRecipe, filters: ModelSearchFilters, hardware: RecipeHardware): boolean {
  return modelMatchesCommonFilters({
    family: recipeFamily(recipe), creator: recipe.source?.split('/')[0] ?? recipe.family ?? '', purposes: recipePurposes(recipe),
    uncensored: recipeUncensored(recipe), tools: recipeTools(recipe), vision: recipe.images === true, fits: recipeFits(recipe, hardware),
  }, filters);
}

export function activeModelFilterCount(filters: ModelSearchFilters): number {
  return Number(filters.family !== 'all') + Number(Boolean(filters.creator.trim())) + Number(filters.purpose !== 'all')
    + Number(filters.uncensored !== 'all') + Number(filters.toolsOnly) + Number(filters.visionOnly)
    + Number(filters.onlyFit) + Number(filters.availableOnly) + Number(filters.minimumContext !== 0);
}

export function familySearchTerm(family: ModelFamily): string {
  if (family === 'all' || family === 'other') return '';
  const terms: Record<Exclude<ModelFamily, 'all' | 'other'>, string> = {
    qwen: 'Qwen', deepseek: 'DeepSeek', llama: 'Llama', gemma: 'Gemma', mistral: 'Mistral', phi: 'Phi', gpt_oss: 'GPT-OSS',
  };
  return terms[family];
}

export function hubSearchQuery(query: string, family: ModelFamily): string {
  const entered = query.trim();
  const familyTerm = familySearchTerm(family);
  if (!familyTerm || entered.toLowerCase().includes(familyTerm.toLowerCase())) return entered;
  return [entered, familyTerm].filter(Boolean).join(' ');
}
