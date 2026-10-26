import type { BenchmarkResult, LaunchProfile, ServerEngine, StrataModelOption } from '../../types/app';
import type { LaunchConfig } from '../../types/config';
import { pathKey, type EngineModel } from '../../lib/engineModels';
import { sameFilePath } from '../../lib/filePaths';
import { extractBenchmarkLaunchConfig } from '../../lib/benchmarkLaunchConfig';
import { PRESETS } from './presets';
import { CONTEXT_STEPS, type TaskCandidate, type TaskDraft, type TaskPlan, type TaskSnapshot } from './types';
import { isSupportedProfileEngine } from '../launches/profiles';

function family(config: LaunchConfig): TaskCandidate['family'] {
  const identity = `${config.modelPath} ${config.engineModel ?? ''}`;
  if (/qwen3[._-]?6/i.test(identity)) return 'qwen36';
  if (/flash.next|qwen4exp/i.test(identity)) return 'flash';
  if (/gpt.oss/i.test(identity)) return 'gptoss';
  return 'other';
}
export function taskCandidates(profiles: LaunchProfile[], strata: StrataModelOption[], library?: EngineModel[]): TaskCandidate[] {
  return profiles.filter(p => !p.unsupportedEngine && !p.config.smartTask && (p.config.modelPath || p.config.engineModel)).flatMap(profile => {
    const c = profile.config, engine = c.engine ?? 'llama_cpp';
    if (!isSupportedProfileEngine(engine)) return [];
    if (library && engine !== 'strata' && !library.some(m => Boolean(m.sources[engine]) && pathKey(m.path) === pathKey(c.modelPath))) return [];
    let maxContext = c.ctxSize;
    if (engine === 'llama_cpp') maxContext = Math.floor(c.ctxSize / Math.max(1, c.parallel));
    if (engine === 'strata') {
      const source = strata.find(s => sameFilePath(s.configPath, String(c.engineOptions?.strata?.strataConfigPath ?? '')));
      // Never infer a Strata launch limit from a stale generic editor value.
      if (!source) return [];
      maxContext = source.contextLength;
    }
    if (!Number.isFinite(maxContext) || maxContext < 8192) return [];
    return [{ id: profile.id, profile, engine: engine as ServerEngine, maxContext, family: family(c) }];
  });
}
function score(candidate: TaskCandidate, draft: TaskDraft): number {
  const use = PRESETS[draft.preset].category;
  // Explicit provisional preferences from the October review; no coding score is invented.
  let value = candidate.profile.lastKnownGood ? 10 : 0;
  if (candidate.family === 'qwen36') value += use === 'coding' || use === 'design' ? 35 : 15;
  if (candidate.family === 'flash') value += use === 'documents' || use === 'analysis' ? 30 : 15;
  if (candidate.family === 'flash' && /iq4.xs/i.test(candidate.profile.config.modelPath)) value += 12;
  if (/nvfp4/i.test(candidate.profile.config.modelPath)) value -= 5;
  if (draft.priority === 'fast' && candidate.family === 'qwen36') value += 10;
  if (draft.priority === 'careful' && candidate.family === 'flash' && /iq4.xs/i.test(candidate.profile.config.modelPath)) value += 10;
  if (/0[._]5b/i.test(candidate.profile.config.modelPath)) value -= 40;
  return value;
}
const freedomTemperature = (freedom: number) => {
  const points = [[0, 0], [20, .2], [50, .6], [80, .9], [100, 1.1]];
  const hi = points.findIndex(([x]) => x >= freedom);
  if (hi <= 0) return 0;
  const [x0, y0] = points[hi - 1], [x1, y1] = points[hi];
  return Math.round((y0 + (freedom - x0) / (x1 - x0) * (y1 - y0)) * 100) / 100;
};

export function planTask(draft: TaskDraft, candidates: TaskCandidate[]): TaskPlan {
  const preset = PRESETS[draft.preset];
  // Auto is a preset-sized budget, not a claim that Aplot has inspected the client's files.
  const context = draft.context === 'auto' ? preset.context : draft.context;
  const ranked = [...candidates].filter(c => c.maxContext >= context).sort((a, b) => score(b, draft) - score(a, draft) || a.profile.name.localeCompare(b.profile.name));
  const candidate = draft.pinnedProfileId ? candidates.find(c => c.id === draft.pinnedProfileId) : ranked[0];
  const outputTokens = preset.output[draft.detail - 1];
  const modelRecipe = candidate?.family === 'qwen36' && candidate.engine === 'strata' && draft.depth > 1;
  const coding = preset.category === 'coding';
  const generic = freedomTemperature(draft.freedom);
  const temperature = draft.pinnedTemperature ?? Math.round((modelRecipe ? (coding ? .6 : 1) + (generic - (coding ? .2 : .6)) * .5 : generic) * 100) / 100;
  const request: Record<string, unknown> = { temperature, top_p: modelRecipe ? .95 : draft.freedom === 0 ? 1 : draft.freedom <= 20 ? .9 : .95, max_tokens: outputTokens };
  if (candidate?.family === 'qwen36' && candidate.engine === 'strata') {
    Object.assign(request, { top_k: 20, min_p: 0, chat_template_kwargs: { enable_thinking: draft.depth > 1 }, reasoning_effort: draft.depth === 1 ? 'none' : draft.depth <= 2 ? 'low' : draft.depth <= 3 ? 'medium' : 'high' });
  }
  if (draft.preset === 'json' && candidate?.engine === 'llama_cpp') request.response_format = { type: 'json_object' };
  const conflict = !candidate ? 'missingModel' : candidate.maxContext < context ? 'context' : outputTokens + 2048 >= context ? 'budget' : undefined;
  let config: LaunchConfig | undefined;
  if (candidate) {
    config = structuredClone(candidate.profile.config);
    config.ctxSize = candidate.engine === 'llama_cpp' ? context * Math.max(1, config.parallel) : context;
    // Only llama.cpp exposes verified server-side sampler defaults in this editor.
    if (candidate.engine === 'llama_cpp') Object.assign(config, { temperature, topP: Number(request.top_p) });
    config.smartTask = { version: 1, sourceProfileId: candidate.id, draft: structuredClone(draft), request, contextPerRequest: context };
  }
  return { candidate, alternatives: ranked.filter(c => c.id !== candidate?.id), context, outputTokens, temperature, request, config, conflict, reasoning: modelRecipe ? 'modelRecipe' : 'instruction', serverDefaults: candidate?.engine === 'llama_cpp' };
}

/** Review data is historical; only exact stored benchmark snapshots may populate the speed metric. */
export function comparableSpeed(plan: TaskPlan, benchmarks: BenchmarkResult[]): BenchmarkResult | undefined {
  if (!plan.config || !plan.serverDefaults) return undefined;
  const config = plan.config;
  const keys: (keyof LaunchConfig)[] = ['engine', 'binaryPath', 'modelPath', 'ctxSize', 'parallel', 'gpuLayers', 'flashAttention', 'kvOffload', 'cacheTypeK', 'cacheTypeV', 'batchSize', 'ubatchSize', 'threads', 'threadsBatch', 'device', 'fit', 'fitTargetMiB', 'splitMode', 'tensorSplit', 'mainGpu', 'continuousBatching', 'temperature', 'topP', 'topK', 'minP', 'typicalP', 'repeatPenalty', 'repeatLastN', 'frequencyPenalty', 'presencePenalty', 'seed', 'reasoning', 'reasoningFormat', 'extraArgs'];
  return benchmarks.find(b => {
    const snapshot = extractBenchmarkLaunchConfig(b.configSnapshot);
    return snapshot && b.profileId === plan.candidate?.id && !b.suiteSummary && b.request.promptTokens >= 3500 && b.request.promptTokens <= 4500
      && keys.every(k => JSON.stringify(snapshot[k]) === JSON.stringify(config[k])) && b.averages.generationTps > 0;
  });
}
export function sameTask(a: TaskSnapshot | undefined, b: TaskSnapshot | undefined): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, canonical(v)])) : value;
  return Boolean(a && b && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)));
}
export function contextIndex(value: number): number { return Math.max(0, CONTEXT_STEPS.findIndex(n => n === value)); }
