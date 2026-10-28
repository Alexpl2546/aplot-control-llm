import { BrainCircuit, Box, Code2, Download, ExternalLink, FileText, Image as ImageIcon, MessageCircle, Search, Sparkles, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { modelCatalog } from '../../lib/modelCatalog';
import type { ModelRecipe } from './recipes';
import type { DownloadSearchResult } from './types';
import {
  hubModelFamily, hubModelPurposes, hubModelTools, hubModelUncensored, hubModelVision, recipeFamily, recipePurposes,
  recipeTools, type ModelFamily, type SearchPurpose,
} from './modelSearchFilters';

const gib = (bytes: number) => (bytes / 2 ** 30).toLocaleString(undefined, { maximumFractionDigits: 2 });

const familyNames: Record<Exclude<ModelFamily, 'all'>, string> = {
  qwen: 'Qwen', deepseek: 'DeepSeek', llama: 'Llama', gemma: 'Gemma', mistral: 'Mistral', phi: 'Phi', gpt_oss: 'GPT-OSS', other: 'Other',
};
const localCreatorIcons = new Set(['google', 'openai', 'ornith', 'prism', 'qwen']);
const purposeIcons = {
  chat: MessageCircle, coding: Code2, analysis: BrainCircuit, agents: Wrench,
  creative: Sparkles, documents: FileText, embeddings: Search,
} satisfies Record<SearchPurpose, typeof MessageCircle>;

function ModelBrandMark({ family, name, path, architecture }: { family: Exclude<ModelFamily, 'all'>; name: string; path: string; architecture?: string }) {
  const catalog = modelCatalog({ name, path, architecture });
  if (catalog && localCreatorIcons.has(catalog.icon)) return <div className="modelCatalogBrandMark" title={catalog.creator}><img src={`/creators/${catalog.icon}.svg`} alt=""/></div>;
  const Icon = family === 'deepseek' ? BrainCircuit : Box;
  return <div className={`modelCatalogBrandMark${family === 'deepseek' ? ' isDeepSeek' : ''}`} title={familyNames[family]}><Icon size={20}/></div>;
}

function PurposeBadge({ purpose }: { purpose: SearchPurpose }) {
  const { t } = useTranslation();
  const Icon = purposeIcons[purpose];
  return <span><Icon size={12}/>{purpose === 'embeddings' ? t('downloads.purposeLabelEmbedding') : t(`models.use.${purpose}`)}</span>;
}

export function HubModelCard({ model, fits, disabled, onSelect }: { model: DownloadSearchResult; fits: boolean; disabled: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const family = hubModelFamily(model);
  const purposes = hubModelPurposes(model);
  const vision = hubModelVision(model);
  const tools = hubModelTools(model);
  const uncensored = hubModelUncensored(model);
  return <article className="modelCatalogCard modelHubCard">
    <header><div className="modelCatalogCardTitle"><ModelBrandMark family={family} name={model.repoId} path={model.repoId} architecture={model.architecture}/><div><h3>{model.repoId.split('/').slice(1).join('/').replace(/-GGUF$/i, '')}</h3><small className="modelCatalogPublisher">{model.repoId}</small></div></div><span className="modelQuantBadge">GGUF</span></header>
    <p className="modelCatalogAbout">{model.description || t(vision ? 'downloads.purposeVision' : model.pipelineTag === 'feature-extraction' ? 'downloads.purposeEmbedding' : 'downloads.purposeText')}</p>
    <div className="modelCapabilityBadges"><span>{familyNames[family]}</span>{purposes.slice(0, 3).map(purpose => <PurposeBadge key={purpose} purpose={purpose}/>)}{vision && <span><ImageIcon size={12}/>{t('downloads.vision')}</span>}{tools && <span><Wrench size={12}/>{t('models.tools')}</span>}{uncensored && <span className="isUncensored">{t('downloads.uncensoredTag')}</span>}</div>
    <dl className="modelCatalogSpecs">
      <div><dt>{t('downloads.parameters')}</dt><dd>{model.parameterCount ? `${(model.parameterCount / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })}B` : '—'}</dd></div>
      <div><dt>{t('parameters.ctxSize')}</dt><dd>{model.contextLength ? `${(model.contextLength / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })}K` : '—'}</dd></div>
      <div title={t('downloads.hubSizeHelp')}><dt>{t('downloads.ggufSize')}</dt><dd>{model.sizeBytes ? `${gib(model.sizeBytes)} ${t('downloads.gib')}` : t('downloads.afterVariant')}</dd></div>
      <div><dt>{t('downloads.license')}</dt><dd>{model.license || '—'}</dd></div>
    </dl>
    {model.sizeBytes ? <div className={`modelMemoryBadge ${fits ? 'fits' : 'tight'}`} title={t('downloads.onlyFitHelp')}>{t(fits ? 'downloads.memoryFits' : 'downloads.memoryTight')}</div> : null}
    <details className="modelCatalogDetails"><summary>{t('downloads.details')}</summary>
      {model.baseModel && <p>{t('downloads.baseModel')}: {model.baseModel}</p>}
      <p>{model.downloads.toLocaleString()} {t('downloads.hubDownloads')} · {model.likes.toLocaleString()} ♥</p>
      <a href={model.repositoryUrl} target="_blank" rel="noreferrer">{t('downloads.modelPage')} <ExternalLink size={12}/></a>
    </details>
    <Button className="primary" disabled={disabled || model.gated} onClick={onSelect}>{t(model.gated ? 'downloads.hubGated' : 'downloads.chooseVariant')}</Button>
  </article>;
}

export function RecipeModelCard({ recipe, fits, disabled, onInstall }: { recipe: ModelRecipe; fits: boolean; disabled: boolean; onInstall: () => void }) {
  const { t } = useTranslation();
  const quant = recipe.model || recipe.name.split(' · ')[1];
  const known = ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S', 'IQ1_M'];
  const description = recipe.engine === 'llama_cpp' ? 'llama' : known.includes(quant ?? '') ? quant : recipe.use === 'coding' ? 'coding' : 'general';
  const family = recipeFamily(recipe);
  const tools = recipeTools(recipe);
  return <article className="modelCatalogCard">
    <header><div className="modelCatalogCardTitle"><ModelBrandMark family={family} name={recipe.name} path={recipe.source ?? recipe.name}/><h3>{recipe.name.replace(/\s*·\s*[^·]+$/, '')}</h3></div>{quant && <span className="modelQuantBadge">{quant}</span>}</header>
    <p className="modelCatalogAbout">{t(`downloads.quantAbout.${description}`)}</p>
    <div className="modelCapabilityBadges"><span>{familyNames[family]}</span>{recipePurposes(recipe).slice(0, 3).map(purpose => <PurposeBadge key={purpose} purpose={purpose}/>)}{recipe.images && <span><ImageIcon size={12}/>{t('downloads.vision')}</span>}{tools && <span><Wrench size={12}/>{t('models.tools')}</span>}{recipe.experimental && <span>{t('downloads.experimental')}</span>}{recipe.nvidiaOnly && <span>NVIDIA</span>}</div>
    <dl className="modelCatalogSpecs">
      <div><dt>{t('downloads.bundleSize')}</dt><dd>≈ {recipe.downloadGiB.toLocaleString(undefined, { maximumFractionDigits: 2 })} {t('downloads.gib')}</dd></div>
      <div><dt>{t(recipe.engine === 'strata' ? 'downloads.weightMemory' : 'downloads.ramMinimum')}</dt><dd>≈ {(recipe.memoryGiB ?? recipe.ramGiB).toLocaleString()} {t('downloads.gib')}</dd></div>
    </dl>
    <div className={`modelMemoryBadge ${fits ? 'fits' : 'tight'}`} title={t('downloads.memoryAdvisory')}>{t(fits ? 'downloads.memoryFits' : 'downloads.memoryTight')}</div>
    <details className="modelCatalogDetails"><summary>{t('downloads.details')}</summary>
      {recipe.engine === 'strata' && <p>{t('downloads.bundleContents')}</p>}
      {recipe.engineMin && <p>Strata ≥ {recipe.engineMin}</p>}
      {recipe.source && <a href={`https://huggingface.co/${recipe.source}`} target="_blank" rel="noreferrer">{recipe.source} <ExternalLink size={12}/></a>}
    </details>
    <Button className="primary" disabled={disabled} onClick={onInstall}><Download size={15}/>{t('recipes.install')}</Button>
  </article>;
}
