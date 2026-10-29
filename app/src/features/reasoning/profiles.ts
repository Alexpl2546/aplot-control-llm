import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { isTauri } from '../../services/tauri';
import { useControlStore } from '../../store/control';
import { modelStoragePath } from '../../lib/engineModels';

/** How a model thinks, as stored per model in `model_reasoning` (see reasoning.rs). */
export interface ReasoningProfile {
  control: 'effort' | 'toggle' | 'none';
  levels: { id: string; label?: string; hint?: string }[];
  default?: string | null;
  canDisable: boolean;
  wire: string;
}
interface Entry { modelKey: string; provider: string; source: string; profile: ReasoningProfile; user?: ReasoningProfile }
interface CatalogEntry { match: string; provider: string; control: ReasoningProfile['control']; levels: string[]; default?: string | null; canDisable?: boolean; wire: string }

/** Same spelling as `reasoning::local_key`: no `\\?\`, backslashes, lower case. */
export const localReasoningKey = (path?: string) => path ? `local:${path.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase()}` : undefined;
export const cloudReasoningKey = (provider: 'codex' | 'claude', connectionId?: string, model?: string) => connectionId && model ? `${provider}:${connectionId}:${model}` : undefined;

export const useReasoningProfiles = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
const remember = (list: Entry[]) => useReasoningProfiles.setState({ entries: Object.fromEntries(list.map(entry => [entry.modelKey, entry])) });

/** The model's list: a hand-made one first, else what the model or its provider said. */
export function reasoningProfile(key?: string): ReasoningProfile | undefined {
  const entry = key ? useReasoningProfiles.getState().entries[key] : undefined;
  return entry?.user ?? entry?.profile;
}
export function useReasoningProfile(key?: string) {
  return useReasoningProfiles(state => { const entry = key ? state.entries[key] : undefined; return entry?.user ?? entry?.profile; });
}

let syncing: Promise<void> | undefined;
/** Local models: with `paths` the rows follow the library (only new or changed files are read); without, the rows are only reloaded. */
export async function syncLocalReasoning(paths?: string[]) {
  if (!isTauri()) return;
  const run = async () => remember(await invoke<Entry[]>('reasoning_profiles', { paths: paths ?? null }));
  syncing = (syncing ?? Promise.resolve()).then(run, run);
  await syncing.catch(() => undefined);
}

/** Codex reports levels and the default per model in its model list. */
export interface CodexListedModel { slug: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string; description?: string }[] }
export async function storeCodexReasoning(connectionId: string, models: CodexListedModel[]) {
  if (!isTauri() || !connectionId) return;
  const entries = models.flatMap(model => {
    const key = cloudReasoningKey('codex', connectionId, model.slug);
    const levels = (model.supported_reasoning_levels ?? []).filter(level => level?.effort).map(level => ({ id: level.effort, hint: level.description }));
    return key && levels.length ? [{ modelKey: key, profile: { control: 'effort', levels, default: model.default_reasoning_level ?? null, canDisable: false, wire: 'codex-effort' } satisfies ReasoningProfile }] : [];
  });
  await invoke('store_reasoning_profiles', { provider: 'codex', scope: `codex:${connectionId}:`, source: 'model-list', models: entries }).catch(() => undefined);
  await syncLocalReasoning();
}

let catalog: Promise<{ models: CatalogEntry[] }> | undefined;
const CATALOG_CHECKED = 'aplot.reasoningCatalogCheckedAt';
/** Claude does not report levels: they come from the catalog, refreshed from the repository once a day. */
export async function storeClaudeReasoning(connectionId: string, models: string[]) {
  if (!isTauri() || !connectionId) return;
  let checked = 0;
  try { checked = Number(localStorage.getItem(CATALOG_CHECKED) ?? 0); } catch { /* optional */ }
  if (Date.now() - checked > 86_400_000) {
    await invoke<boolean>('refresh_reasoning_catalog').then(() => { catalog = undefined; }, () => undefined);
    try { localStorage.setItem(CATALOG_CHECKED, String(Date.now())); } catch { /* optional */ }
  }
  catalog ??= invoke<{ models: CatalogEntry[] }>('reasoning_catalog');
  // A catalog that fails to load or has no list leaves Claude on the usual levels.
  const loaded = await catalog.catch(() => undefined);
  const rules = (Array.isArray(loaded?.models) ? loaded.models : []).filter(rule => rule?.provider === 'claude' && Array.isArray(rule.levels));
  const entries = models.flatMap(model => {
    const rule = rules.find(item => item.match === '*' || model.startsWith(item.match));
    const key = cloudReasoningKey('claude', connectionId, model);
    return rule && key ? [{ modelKey: key, profile: { control: rule.control, levels: rule.levels.map(id => ({ id })), default: rule.default ?? null, canDisable: Boolean(rule.canDisable), wire: rule.wire } satisfies ReasoningProfile }] : [];
  });
  await invoke('store_reasoning_profiles', { provider: 'claude', scope: `claude:${connectionId}:`, source: 'catalog', models: entries }).catch(() => undefined);
  await syncLocalReasoning();
}

/** Called after a library scan, never before the first one: an empty list then means "no models". */
export function libraryReasoning(paths: string[]) {
  void syncLocalReasoning(paths);
}

/** The model behind an agent task: its cloud model, or the local server it is bound to. */
export function taskReasoningKey(task: { runtime?: string; connectionId?: string; cloudModel?: string; codexModel?: string; binding?: { runId?: string } } | undefined, modelPathOf: (runId: string) => string | undefined) {
  if (!task) return undefined;
  if (task.runtime === 'codex') return cloudReasoningKey('codex', task.connectionId, task.codexModel ?? task.cloudModel);
  if (task.runtime === 'claude') return cloudReasoningKey('claude', task.connectionId, task.cloudModel);
  return localReasoningKey(task.binding?.runId ? modelPathOf(task.binding.runId) : undefined);
}

// The library is scanned at start and after downloads, removals and folder changes; each scan syncs the rows.
const libraryPaths = () => (useControlStore.getState().libraryModels ?? []).flatMap(model => { const path = modelStoragePath(model); return path ? [path] : []; });
useControlStore.subscribe((state, previous) => {
  if (state.initialized && (state.libraryModels !== previous.libraryModels || !previous.initialized)) libraryReasoning(libraryPaths());
});
