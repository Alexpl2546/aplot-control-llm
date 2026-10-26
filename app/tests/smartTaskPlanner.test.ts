import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/types/config';
import type { LaunchProfile, StrataModelOption, BenchmarkResult, ServerEngine } from '../src/types/app';
import { planTask, taskCandidates, sameTask, comparableSpeed } from '../src/features/smartTasks/planner';
import { presetDraft, validDraft } from '../src/features/smartTasks/presets';

function profile(id: string, engine: ServerEngine, ctxSize = 32768): LaunchProfile {
  return { id, name: id, config: { ...structuredClone(DEFAULT_CONFIG), profileId: id, profileName: id, engine, ctxSize, parallel: 1,
    modelPath: `C:/models/${id}.gguf`, engineOptions: engine === 'strata' ? { strata: { strataConfigPath: `C:/engines/strata-${id}.json` } } : {} },
    createdAt: '2026-10-14', updatedAt: '2026-10-14', lastKnownGood: true };
}
const qwen = profile('qwen3.6-35b', 'strata');
const flash = profile('flash-next-iq4_xs', 'strata', 131072);
const strata: StrataModelOption[] = [qwen, flash].map(p => ({ configPath: String(p.config.engineOptions?.strata?.strataConfigPath), modelName: p.name, modelPath: p.config.modelPath, contextLength: p.config.ctxSize }));

describe('semantic task planning', () => {
  it('starts coding at 20/32K/3/3 and gives Qwen a model-specific recipe without mutating profiles', () => {
    const source = JSON.stringify([qwen, flash]);
    const draft = presetDraft('coding');
    const plan = planTask(draft, taskCandidates([flash, qwen], strata));
    expect(draft).toMatchObject({ freedom: 20, context: 32768, depth: 3, detail: 3 });
    expect(plan.candidate?.id).toBe(qwen.id);
    expect(plan.temperature).toBe(.6);
    expect(plan.outputTokens).toBe(4096);
    expect(plan.request).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
    expect(planTask({ ...draft, freedom: 90 }, taskCandidates([qwen], strata)).temperature).toBeGreaterThan(plan.temperature);
    expect(JSON.stringify([qwen, flash])).toBe(source);
  });
  it('switches the recommendation for a bigger task, but reports a conflict when the small model is pinned', () => {
    const candidates = taskCandidates([qwen, flash], strata);
    expect(planTask({ ...presetDraft('coding'), context: 65536 }, candidates).candidate?.id).toBe(flash.id);
    const pinned = planTask({ ...presetDraft('coding'), context: 65536, pinnedProfileId: qwen.id }, candidates);
    expect(pinned.candidate?.id).toBe(qwen.id);
    expect(pinned.conflict).toBe('context');
  });
  it('retains manual pins across preset changes and changes only request values for Strata', () => {
    const draft = presetDraft('design', { pinnedProfileId: qwen.id, pinnedTemperature: .25 });
    const plan = planTask(draft, taskCandidates([qwen], strata));
    expect(plan.temperature).toBe(.25);
    expect(plan.config?.temperature).toBe(qwen.config.temperature);
    expect(plan.config?.engineOptions).toEqual(qwen.config.engineOptions);
    expect(draft.pinnedProfileId).toBe(qwen.id);
  });
  it('treats llama.cpp context as a pool and preserves MTP/cache workarounds', () => {
    const p = profile('rvn', 'llama_cpp', 131072);
    p.config.parallel = 2; p.config.extraArgs = '--spec-type none --no-cache-prompt --cache-ram 0 --ctx-checkpoints 0';
    const candidates = taskCandidates([p], []);
    expect(candidates[0].maxContext).toBe(65536);
    const plan = planTask({ ...presetDraft('coding'), context: 65536 }, candidates);
    expect(plan.config?.ctxSize).toBe(131072);
    expect(plan.config?.temperature).toBe(.2);
    expect(plan.config?.extraArgs).toBe(p.config.extraArgs);
    expect(planTask({ ...presetDraft('coding'), context: 131072 }, candidates).conflict).toBe('missingModel');
  });
  it('excludes legacy engine profiles from task recommendations', () => {
    const legacy = profile('legacy', 'llama_cpp', 65536);
    legacy.config.engine = 'ollama';
    legacy.unsupportedEngine = 'ollama';
    expect(taskCandidates([legacy], [])).toEqual([]);
  });
  it('rejects missing catalog models and Strata configurations instead of assuming availability', () => {
    expect(taskCandidates([profile('missing', 'llama_cpp')], [], [])).toEqual([]);
    expect(taskCandidates([qwen], [])).toEqual([]);
  });
  it('uses preset context for auto, rejects impossible output budgets and malformed persisted drafts', () => {
    const candidates = taskCandidates([flash], strata);
    expect(planTask({ ...presetDraft('documents'), context: 'auto' }, candidates).context).toBe(32768);
    expect(planTask({ ...presetDraft('coding'), context: 8192, detail: 5 }, candidates).conflict).toBe('budget');
    expect(validDraft({ ...presetDraft('coding'), freedom: Infinity })).toBe(false);
    expect(validDraft({ ...presetDraft('coding'), context: 1234 })).toBe(false);
    expect(validDraft({ ...presetDraft('coding'), pinnedTemperature: -1 })).toBe(false);
  });
  it('does not feed derived task profiles back into automatic recommendations', () => {
    const derived = structuredClone(qwen);
    derived.config.smartTask = planTask(presetDraft('coding'), taskCandidates([qwen], strata)).config!.smartTask;
    expect(taskCandidates([derived], strata)).toEqual([]);
  });
  it('recognizes an applied snapshot after native JSON key reordering', () => {
    const snapshot = planTask(presetDraft('coding'), taskCandidates([qwen], strata)).config!.smartTask!;
    // Reorder the top-level keys as serde_json does, preserving nested contents.
    expect(sameTask(snapshot, Object.fromEntries(Object.entries(snapshot).reverse()) as typeof snapshot)).toBe(true);
    expect(sameTask(snapshot, { ...snapshot, contextPerRequest: 65536 })).toBe(false);
  });
  it('does not show unrelated or different-sampler throughput as a comparable speed', () => {
    const p = profile('coder', 'llama_cpp');
    const plan = planTask(presetDraft('coding'), taskCandidates([p], []));
    const benchmark = { profileId: p.id, configSnapshot: plan.config, request: { promptTokens: 4096 }, averages: { generationTps: 55 } } as BenchmarkResult;
    expect(comparableSpeed(plan, [benchmark])).toBe(benchmark);
    expect(comparableSpeed(plan, [{ ...benchmark, configSnapshot: { ...plan.config!, temperature: .8 } }])).toBeUndefined();
    expect(comparableSpeed(plan, [{ ...benchmark, request: { ...benchmark.request, promptTokens: 2048 } }])).toBeUndefined();
  });
});
