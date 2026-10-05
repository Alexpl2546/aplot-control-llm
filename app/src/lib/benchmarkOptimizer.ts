import type { LaunchConfig, LlamaCapabilities } from "../types/config";
import { isParameterAvailable, PARAMETER_REGISTRY } from "./parameters";
import { validateConfig } from "./validation";
import type { BenchmarkProfileGoal, BenchmarkResult } from "../types/app";
import { splitExtraArgs } from "./cli";

export const MINIMUM_AGENT_CONTEXT = 65_536;
export const DEFAULT_SEARCH_CONTEXT = 262_144;
export const MAXIMUM_SEARCH_CONTEXT = 1_048_576;

export interface BenchmarkCandidate {
  id: string;
  config: LaunchConfig;
  changedKeys: (keyof LaunchConfig)[];
}

const isSupported = (key: keyof LaunchConfig, capabilities: LlamaCapabilities) => {
  const parameter = PARAMETER_REGISTRY.find(candidate => candidate.key === key);
  return Boolean(parameter && isParameterAvailable(parameter, capabilities));
};

/** Build a small, capability-aware set of one-factor launch candidates. */
export function buildBenchmarkCandidates(config: LaunchConfig, capabilities: LlamaCapabilities): BenchmarkCandidate[] {
  const candidates: BenchmarkCandidate[] = [{ id: "baseline", config: structuredClone(config), changedKeys: [] }];
  const seen = new Set([JSON.stringify(config)]);
  const add = (id: string, changes: Partial<LaunchConfig>) => {
    const changedKeys = Object.keys(changes) as (keyof LaunchConfig)[];
    if (changedKeys.some(key => !isSupported(key, capabilities))) return;
    const next = { ...config, ...changes };
    if (validateConfig(next, capabilities).some(issue => issue.severity === "error")) return;
    const signature = JSON.stringify(next);
    if (seen.has(signature) || candidates.length >= 6) return;
    seen.add(signature);
    candidates.push({ id, config: next, changedKeys });
  };

  add("batch-1024", { batchSize: 1024, ubatchSize: 256 });
  add("batch-2048", { batchSize: 2048, ubatchSize: 512 });

  if (isSupported("parallel", capabilities)) {
    add("parallel-1", { parallel: 1 });
    add("parallel-2", { parallel: 2 });
  }

  const cacheOptions = ["q8_0", "q4_0", "f16"] as const;
  for (const cache of cacheOptions) {
    if (!capabilities.kvCacheTypes.includes(cache)) continue;
    add(`kv-${cache}`, { cacheTypeK: cache, cacheTypeV: cache });
  }

  return candidates;
}

/** Bounded search: one full context slot, fixed allocation, then KV/batch variants. */
export function buildProfileSearchCandidates(
  config: LaunchConfig,
  capabilities: LlamaCapabilities,
  minimumContext: number,
  maximumContext: number,
): BenchmarkCandidate[] {
  if (!Number.isInteger(minimumContext) || !Number.isInteger(maximumContext)
    || minimumContext < MINIMUM_AGENT_CONTEXT || maximumContext < minimumContext
    || maximumContext > MAXIMUM_SEARCH_CONTEXT || !isSupported("ctxSize", capabilities)) return [];
  // Do not silently let --fit reduce the requested context or parallel split it.
  if (config.parallel !== 1 && !isSupported("parallel", capabilities)) return [];
  if (config.fit && !isSupported("fit", capabilities)) return [];
  if (splitExtraArgs(config.extraArgs).some(arg => /^(?:--(?:ctx-size|parallel|fit|fit-ctx|cache-type-k|cache-type-v|batch-size|ubatch-size)|-c|-np|-ctk|-ctv|-b|-ub)(?:=|$)/.test(arg))) return [];
  const fixed = { ...config, parallel: 1, fit: false };
  const contexts = [minimumContext];
  for (let context = minimumContext * 2; context < maximumContext; context *= 2) contexts.push(context);
  if (maximumContext !== minimumContext) contexts.push(maximumContext);
  const candidates: BenchmarkCandidate[] = [];
  for (const ctxSize of contexts) {
    const base = { ...fixed, ctxSize };
    const variants = buildBenchmarkCandidates(base, capabilities).filter(candidate => candidate.config.parallel === 1);
    // Search all contexts with the same variations; never let low-context variants crowd out the upper bound.
    for (const variant of variants) {
      const changedKeys = (Object.keys(config) as (keyof LaunchConfig)[])
        .filter(key => JSON.stringify(config[key]) !== JSON.stringify(variant.config[key]));
      if (validateConfig(variant.config, capabilities).some(issue => issue.severity === "error")) continue;
      candidates.push({ id: `ctx-${ctxSize}-${variant.id}`, config: variant.config, changedKeys });
    }
  }
  return candidates;
}

/** Compare measured throughput with context; failed or incomplete measurements never rank. */
export function rankProfileResults(results: BenchmarkResult[], goal: BenchmarkProfileGoal, minimumContext: number): BenchmarkResult[] {
  const passing = results.filter(result => result.meetsTargets === true
    && Number.isFinite(result.averages.generationTps) && result.averages.generationTps > 0
    && (result.configSnapshot?.ctxSize ?? 0) >= minimumContext
    && result.configSnapshot?.parallel === 1 && result.configSnapshot?.fit === false);
  const maxContext = Math.max(1, ...passing.map(result => result.configSnapshot!.ctxSize!));
  const maxSpeed = Math.max(1, ...passing.map(result => result.averages.generationTps));
  const score = (result: BenchmarkResult) => Math.sqrt((result.configSnapshot!.ctxSize! / maxContext) * (result.averages.generationTps / maxSpeed));
  return passing.sort((a, b) => {
    const contextDifference = b.configSnapshot!.ctxSize! - a.configSnapshot!.ctxSize!;
    const speedDifference = b.averages.generationTps - a.averages.generationTps;
    if (goal === "maxContext") return contextDifference || speedDifference;
    if (goal === "maxSpeed") return speedDifference || contextDifference;
    return score(b) - score(a) || speedDifference || contextDifference;
  });
}
