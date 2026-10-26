import { Download, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import type { ModelRecipe } from './recipes';
import type { DownloadSearchResult } from './types';

const gib = (bytes: number) => (bytes / 2 ** 30).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function HubModelCard({ model, disabled, onSelect }: { model: DownloadSearchResult; disabled: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const vision = model.pipelineTag?.includes('image') || model.tags.some(tag => ['vision', 'multimodal'].includes(tag));
  return <article className="modelCatalogCard modelHubCard">
    <header><h3>{model.repoId.split('/').slice(1).join('/').replace(/-GGUF$/i, '')}</h3><span className="modelQuantBadge">GGUF</span></header>
    <small className="modelCatalogPublisher">{model.repoId}</small>
    <p className="modelCatalogAbout">{model.description || t(vision ? 'downloads.purposeVision' : model.pipelineTag === 'feature-extraction' ? 'downloads.purposeEmbedding' : 'downloads.purposeText')}</p>
    <div className="modelCapabilityBadges"><span>{t(vision ? 'downloads.vision' : 'models.text')}</span>{model.architecture && <span>{model.architecture}</span>}</div>
    <dl className="modelCatalogSpecs">
      <div><dt>{t('downloads.parameters')}</dt><dd>{model.parameterCount ? `${(model.parameterCount / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })}B` : '—'}</dd></div>
      <div><dt>{t('parameters.ctxSize')}</dt><dd>{model.contextLength ? `${(model.contextLength / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })}K` : '—'}</dd></div>
      <div title={t('downloads.hubSizeHelp')}><dt>{t('downloads.ggufSize')}</dt><dd>{model.sizeBytes ? `${gib(model.sizeBytes)} ${t('downloads.gib')}` : t('downloads.afterVariant')}</dd></div>
      <div><dt>{t('downloads.license')}</dt><dd>{model.license || '—'}</dd></div>
    </dl>
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
  return <article className="modelCatalogCard">
    <header><h3>{recipe.name.replace(/\s*·\s*[^·]+$/, '')}</h3>{quant && <span className="modelQuantBadge">{quant}</span>}</header>
    <p className="modelCatalogAbout">{t(`downloads.quantAbout.${description}`)}</p>
    <div className="modelCapabilityBadges"><span>{t(`models.use.${recipe.use}`)}</span>{recipe.images && <span>{t('downloads.vision')}</span>}{recipe.experimental && <span>{t('downloads.experimental')}</span>}{recipe.nvidiaOnly && <span>NVIDIA</span>}</div>
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
