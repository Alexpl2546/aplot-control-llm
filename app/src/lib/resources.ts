import type { LaunchConfig } from "../types/config";

const KV_BYTES: Record<string, number> = { f32: 4, f16: 2, bf16: 2, q8_0: 1.0625, q5_0: 0.6875, q5_1: 0.6875, q4_0: 0.5625, q4_1: 0.625, iq4_nl: 0.5625 };
export interface ResourceEstimate { modelGiB: number; kvCacheGiB: number; estimatedVramGiB: number; estimatedRamGiB: number; headroomGiB: number; confidence: "low" | "medium"; notes: string[]; }

export function estimateResources(config: LaunchConfig, gpuTotalGiB = 16): ResourceEstimate {
  const modelGiB = (config.modelBytes ?? 0) / 1024 ** 3;
  const kBytes = KV_BYTES[config.cacheTypeK] ?? 2;
  const vBytes = KV_BYTES[config.cacheTypeV] ?? 2;
  const layers = config.modelLayers ?? 48;
  const embedding = config.modelEmbeddingLength ?? 4096;
  const heads = config.modelHeadCount ?? 32;
  const kvHeads = config.modelHeadCountKv ?? heads;
  const headDim = embedding / Math.max(1, heads);
  const architectureAware = Boolean(config.modelLayers && config.modelEmbeddingLength && config.modelHeadCount && config.modelHeadCountKv);
  const kvBytes = config.ctxSize * layers * kvHeads * headDim * (kBytes + vBytes);
  const kvCacheGiB = kvBytes / 1024 ** 3;
  const gpuLayerFraction = config.gpuLayers === "all" ? 1 : config.gpuLayers === "auto" ? 0.85 : Math.max(0, Math.min(1, config.gpuLayers / Math.max(1, layers)));
  // The GGUF file contains metadata and non-layer tensors, so keep a small host/overhead margin.
  const modelOnGpu = modelGiB * (config.gpuLayers === "all" ? 0.96 : gpuLayerFraction * 0.94);
  const kvOnGpu = config.kvOffload ? kvCacheGiB : 0;
  const workspace = Math.max(0.65, config.batchSize / 2048 * 0.55) + config.parallel * 0.12;
  const estimatedVramGiB = modelOnGpu + kvOnGpu + workspace;
  const estimatedRamGiB = Math.max(2, modelGiB * (1 - gpuLayerFraction) + (config.kvOffload ? 1.5 : kvCacheGiB) + 2.5);
  return {
    modelGiB, kvCacheGiB, estimatedVramGiB, estimatedRamGiB,
    headroomGiB: gpuTotalGiB - estimatedVramGiB,
    confidence: architectureAware ? "medium" : "low",
    notes: architectureAware
      ? ["KV estimate uses GGUF layer/head metadata.", "Exact allocation still depends on llama.cpp build, backend and --fit."]
      : ["Generic estimator because required GGUF architecture metadata is unavailable.", "llama.cpp --fit remains the authoritative runtime allocator when enabled."]
  };
}
