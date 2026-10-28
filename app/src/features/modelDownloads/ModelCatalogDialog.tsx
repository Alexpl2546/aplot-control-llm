import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Filter, FolderOpen, HardDrive, Search } from 'lucide-react';
import { WorkspaceDialog } from '../agent/WorkspacePanels';
import { Button, Input, Select } from '../../components/ui/Primitives';
import { useControlStore } from '../../store/control';
import { isTauri } from '../../services/tauri';
import { pickDirectory } from '../../services/dialog';
import { openSettingsSection } from '../../services/settingsWindow';
import { ENGINE_NAMES } from '../../lib/engineModels';
import type { ServerEngine } from '../../types/app';
import { MODEL_RECIPES, loadModelRecipes, recipeFits, type ModelRecipe } from './recipes';
import { beginModelRecipe, currentRecipeHardware, readRecipeHardware, useAcquisitionStore } from './acquisition';
import { modelDownloadDestination, searchModelDownloads } from './service';
import type { DownloadSearchResult, ModelSearchOptions } from './types';
import { HubModelCard, RecipeModelCard } from './ModelCatalogCards';
import {
  activeModelFilterCount, DEFAULT_MODEL_SEARCH_FILTERS, hubSearchQuery, matchesHubModel, matchesRecipe,
  hubModelFitsMemory, type ModelFamily, type ModelSearchFilters,
} from './modelSearchFilters';

interface Props {
  onClose: () => void;
  onAdvanced: (source?: string, destination?: string) => void;
  onQueued: () => void;
  initialEngine: ServerEngine;
}

type FilterUpdater = <K extends keyof ModelSearchFilters>(key: K, value: ModelSearchFilters[K]) => void;

function ModelSearchFilterPanel({ engine, filters, onChange, onClear }: {
  engine: ServerEngine; filters: ModelSearchFilters; onChange: FilterUpdater; onClear: () => void;
}) {
  const { t } = useTranslation();
  const count = activeModelFilterCount(filters);
  return <details className="modelSearchFilters">
    <summary><Filter size={15}/>{t('downloads.filters')}{count > 0 && <span className="modelSearchFilterCount">{t('downloads.filtersCount', { count })}</span>}</summary>
    <div className="modelSearchFilterGrid">
      <label>{t('downloads.family')}<Select value={filters.family} onChange={event => onChange('family', event.target.value as ModelFamily)}>
        <option value="all">{t('downloads.familyAll')}</option>
        <option value="qwen">Qwen</option><option value="deepseek">DeepSeek</option><option value="llama">Llama</option>
        <option value="gemma">Gemma</option><option value="mistral">Mistral</option><option value="phi">Phi</option>
        <option value="gpt_oss">GPT-OSS</option><option value="other">{t('downloads.familyOther')}</option>
      </Select></label>
      <label>{t('downloads.purpose')}<Select value={filters.purpose} onChange={event => onChange('purpose', event.target.value as ModelSearchFilters['purpose'])}>
        <option value="all">{t('downloads.purposeAll')}</option>
        <option value="chat">{t('models.use.chat')}</option><option value="coding">{t('models.use.coding')}</option>
        <option value="analysis">{t('models.use.analysis')}</option><option value="agents">{t('models.use.agents')}</option>
        <option value="creative">{t('models.use.creative')}</option><option value="documents">{t('models.use.documents')}</option>
        <option value="embeddings">{t('downloads.purposeLabelEmbedding')}</option>
      </Select></label>
      <label>{t('downloads.developer')}<Input value={filters.creator} onChange={event => onChange('creator', event.target.value)} placeholder="Qwen, deepseek-ai…"/></label>
      <label>{t('downloads.uncensored')}<Select value={filters.uncensored} onChange={event => onChange('uncensored', event.target.value as ModelSearchFilters['uncensored'])}>
        <option value="all">{t('downloads.uncensoredAll')}</option><option value="marked">{t('downloads.uncensoredMarked')}</option>
        <option value="unmarked">{t('downloads.uncensoredUnmarked')}</option>
      </Select></label>
      {engine === 'llama_cpp' && <label>{t('downloads.minimumContext')}<Select value={filters.minimumContext} onChange={event => onChange('minimumContext', Number(event.target.value) as ModelSearchFilters['minimumContext'])}>
        <option value={0}>{t('downloads.contextAny')}</option><option value={32768}>32K+</option><option value={131072}>128K+</option>
      </Select></label>}
      <div className="modelSearchFilterChecks">
        <label className="oaCheck"><input type="checkbox" checked={filters.toolsOnly} onChange={event => onChange('toolsOnly', event.target.checked)}/>{t('downloads.toolsOnly')}</label>
        <label className="oaCheck"><input type="checkbox" checked={filters.visionOnly} onChange={event => onChange('visionOnly', event.target.checked)}/>{t('downloads.visionOnly')}</label>
        {engine === 'llama_cpp' && <label className="oaCheck"><input type="checkbox" checked={filters.availableOnly} onChange={event => onChange('availableOnly', event.target.checked)}/>{t('downloads.availableOnly')}</label>}
      </div>
    </div>
    <div className="modelSearchFilterFooter"><p>{t('downloads.filterHelp')}</p>{count > 0 && <Button onClick={onClear}>{t('downloads.clearFilters')}</Button>}</div>
  </details>;
}

export function ModelCatalogDialog({ onClose, onAdvanced, onQueued, initialEngine }: Props) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState(initialEngine);
  const [filters, setFilters] = useState<ModelSearchFilters>(DEFAULT_MODEL_SEARCH_FILTERS);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [hardware, setHardware] = useState(currentRecipeHardware);
  const [catalog, setCatalog] = useState<readonly ModelRecipe[]>(MODEL_RECIPES);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [destinations, setDestinations] = useState<Partial<Record<ServerEngine, string>>>({});
  const [defaults, setDefaults] = useState<Partial<Record<ServerEngine, string>>>({});
  const destination = destinations[engine] ?? defaults[engine] ?? '';
  const setDestination = (value: string) => setDestinations(current => ({ ...current, [engine]: value }));
  const [sort, setSort] = useState<NonNullable<ModelSearchOptions['sort']>>('downloads');
  const [allGguf, setAllGguf] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [strataQuery, setStrataQuery] = useState('');
  const [results, setResults] = useState<DownloadSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchRequest = useRef(0);
  const busy = useAcquisitionStore(state => state.busy);
  const preparation = useAcquisitionStore(state => state.preparation);
  const installed = useControlStore(state => state.availableEngines);
  const strataRoot = useControlStore(state => state.settings.strataRootPath);
  const effectiveHubQuery = [hubSearchQuery(query, filters.family), filters.creator.trim()].filter(Boolean).join(' ');
  const updateFilter: FilterUpdater = (key, value) => setFilters(current => ({ ...current, [key]: value }));

  useEffect(() => {
    let disposed = false;
    void readRecipeHardware().then(value => { if (!disposed) setHardware(value); }).catch(() => { /* Hardware estimates are advisory. */ });

    return () => { disposed = true; searchRequest.current += 1; };
  }, []);

  useEffect(() => {
    let disposed = false;
    void modelDownloadDestination(engine).then(value => { if (!disposed) setDefaults(current => ({ ...current, [engine]: value })); })
      .catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [engine]);

  useEffect(() => {
    if (engine !== 'strata') return;
    let disposed = false;
    setLoadingCatalog(true);
    setCatalogError('');
    void loadModelRecipes(strataRoot).then(value => { if (!disposed) setCatalog(value); })
      .catch(cause => { if (!disposed) { setCatalog(MODEL_RECIPES); setCatalogError(String(cause)); } })
      .finally(() => { if (!disposed) setLoadingCatalog(false); });
    return () => { disposed = true; };
  }, [engine, strataRoot]);

  // Debounce Hub requests and ignore responses for an earlier query or engine.
  useEffect(() => {
    const request = ++searchRequest.current;
    if (engine !== 'llama_cpp') { setSearching(false); return; }
    setSearching(true);
    setLoadingMore(false);
    setNextCursor(undefined);
    setSearchError('');
    const timer = setTimeout(() => {
      void searchModelDownloads(effectiveHubQuery, { sort, allGguf }).then(value => { if (request === searchRequest.current) { setResults(value.items); setNextCursor(value.nextCursor ?? undefined); } })
        .catch(cause => { if (request === searchRequest.current) { setResults([]); setSearchError(String(cause)); } })
        .finally(() => { if (request === searchRequest.current) setSearching(false); });
    }, effectiveHubQuery ? 350 : 0);
    return () => { clearTimeout(timer); if (searchRequest.current === request) searchRequest.current += 1; };
  }, [engine, effectiveHubQuery, sort, allGguf]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const request = searchRequest.current;
    setLoadingMore(true); setSearchError('');
    try {
      const page = await searchModelDownloads(effectiveHubQuery, { sort, allGguf, cursor: nextCursor });
      if (request !== searchRequest.current) return;
      setResults(current => { const seen = new Set(current.map(item => item.repoId)); return [...current, ...page.items.filter(item => !seen.has(item.repoId))]; });
      setNextCursor(page.nextCursor ?? undefined);
    } catch (cause) { if (request === searchRequest.current) setSearchError(String(cause)); }
    finally { if (request === searchRequest.current) setLoadingMore(false); }
  };

  const recipes = catalog.filter(item => item.engine === engine && matchesRecipe(item, filters, hardware)
    && (engine !== 'strata' || `${item.name} ${item.family ?? ''} ${item.model ?? ''}`.toLowerCase().includes(strataQuery.trim().toLowerCase())));
  const visibleResults = results.filter(item => matchesHubModel(item, filters, hardware));
  const preparing = preparation?.state === 'installing';
  const install = async (id: string) => {
    setError('');
    try { await beginModelRecipe(id, destination.trim()); onClose(); onQueued(); }
    catch (cause) { setError(String(cause)); }
  };
  const chooseDestination = async () => {
    try { const selected = await pickDirectory(); if (selected) setDestination(selected); }
    catch (cause) { setError(String(cause)); }
  };

  return <WorkspaceDialog title={t('downloads.dialogTitle')} wide onClose={() => { if (!busy) onClose(); }}>
    <div className="modelCatalog">
      <p className="oaHelp">{t('recipes.help')}</p>
      <div className="libraryFilters" role="group" aria-label={t('library.engineFilter')}>
        {(['llama_cpp', 'strata'] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={engine === value} className={engine === value ? 'active' : ''} onClick={() => setEngine(value)}>{ENGINE_NAMES[value]}</button>)}
      </div>
      {!isTauri() && <p className="oaHelp">{t('downloads.demoMode')}</p>}
      <div className="modelDownloadDestination">
        <label htmlFor="catalog-destination">{t('downloads.destination')}</label>
        <div><Input id="catalog-destination" value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}/><Button aria-label={t('downloads.chooseDestination')} disabled={busy || !isTauri()} onClick={() => void chooseDestination()}><FolderOpen size={16}/></Button></div>
      </div>
      {!installed.includes(engine) && <div className="serverHeroNotice"><p>{t('recipes.engineMissing', { engine: ENGINE_NAMES[engine] })}</p><Button onClick={() => { onClose(); openSettingsSection('components'); }}>{t('profiles.manageComponents')}</Button></div>}
      <div className="modelCatalogHardwareControls"><p className="modelCatalogHardware"><HardDrive size={15}/>{t('recipes.hardware', { ram: hardware.ramGiB.toFixed(1), free: hardware.freeRamGiB.toFixed(1), vram: hardware.vramGiB.toFixed(1) })}</p>
        <label className="oaCheck" title={t('downloads.onlyFitHelp')}><input type="checkbox" checked={filters.onlyFit} onChange={event => updateFilter('onlyFit', event.target.checked)}/>{t('recipes.onlyFit')}</label></div>
      {engine === 'llama_cpp' && <section className="modelHubSearch" aria-label={t('downloads.hubTitle')}>
        <div className="modelCatalogSectionTitle"><h3>{t('downloads.hubTitle')}</h3><a href="https://huggingface.co/models?apps=llama.cpp&library=gguf" target="_blank" rel="noreferrer">{t('downloads.fullCatalog')} <ExternalLink size={13}/></a></div>
        <label htmlFor="model-hub-query">{t('downloads.hubQuery')}</label>
        <div className="modelDownloadSourceRow"><Search size={16} aria-hidden="true"/><Input id="model-hub-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Qwen, Gemma, Llama, Mistral, DeepSeek…"/></div>
        <ModelSearchFilterPanel engine={engine} filters={filters} onChange={updateFilter} onClear={() => setFilters(DEFAULT_MODEL_SEARCH_FILTERS)}/>
        <div className="modelHubControls">
          <Select aria-label={t('downloads.sort')} value={sort} onChange={event => setSort(event.target.value as NonNullable<ModelSearchOptions['sort']>)}><option value="downloads">{t('downloads.sortPopular')}</option><option value="lastModified">{t('downloads.sortUpdated')}</option><option value="likes">{t('downloads.sortLiked')}</option></Select>
          <label className="oaCheck"><input type="checkbox" checked={allGguf} onChange={event => setAllGguf(event.target.checked)}/>{t('downloads.allGguf')}</label>
          <Button disabled={busy} onClick={() => onAdvanced(undefined, destination.trim())}>{t('downloads.byLink')}</Button>
        </div>
        <p className="oaHelp">{t('downloads.hubHelp')}</p>
        {searching ? <p role="status">{t('downloads.loading')}</p> : <div className="modelCatalogCards modelHubResults">
          {visibleResults.map(result => <HubModelCard key={result.repoId} model={result} fits={hubModelFitsMemory(result, hardware)} disabled={busy} onSelect={() => onAdvanced(result.repoId, destination.trim())}/>)}
          {!results.length && !searchError && <p>{t('downloads.hubEmpty')}</p>}
          {results.length > 0 && !visibleResults.length && <p>{t('downloads.noFilteredResults')}</p>}
        </div>}
        {nextCursor && !searching && <Button disabled={loadingMore} onClick={() => void loadMore()}>{t(loadingMore ? 'downloads.loading' : 'downloads.loadMore')}</Button>}
        {searchError && <p role="alert" className="awError">{searchError}</p>}
      </section>}
      {engine === 'strata' && <><div className="modelCatalogSectionTitle"><h3>{t('downloads.strataCatalog')}</h3><span>{recipes.length}</span></div><label className="modelCatalogSearch">{t('downloads.strataQuery')}<Input value={strataQuery} onChange={event => setStrataQuery(event.target.value)} placeholder="Qwen, DeepSeek, Unsloth, NVFP4…"/></label>
        <ModelSearchFilterPanel engine={engine} filters={filters} onChange={updateFilter} onClear={() => setFilters(DEFAULT_MODEL_SEARCH_FILTERS)}/></>}
      {catalogError && engine === 'strata' && <p role="alert" className="modelDownloadWarning">{t('downloads.catalogFallback')} {catalogError}</p>}
      {engine === 'strata' ? loadingCatalog ? <p role="status">{t('downloads.working')}</p> : <div className="modelCatalogCards">
        {recipes.map(recipe => <RecipeModelCard key={recipe.id} recipe={recipe} fits={recipeFits(recipe, hardware)} disabled={busy || !destination.trim() || !installed.includes(engine) || preparing || !isTauri()} onInstall={() => void install(recipe.id)}/>)}
        {!recipes.length && <p>{filters.onlyFit ? t('recipes.noneFit') : t('downloads.noFilteredResults')}</p>}
      </div> : <details className="modelQuickStart"><summary>{t('downloads.quickRecipes')}</summary><div className="modelCatalogCards">{recipes.map(recipe => <RecipeModelCard key={recipe.id} recipe={recipe} fits={recipeFits(recipe, hardware)} disabled={busy || !destination.trim() || !installed.includes(engine)} onInstall={() => void install(recipe.id)}/>)}</div></details>}
      {error && <p role="alert" className="awError">{error}</p>}

    </div>
  </WorkspaceDialog>;
}
