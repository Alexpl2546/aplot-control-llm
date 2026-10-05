import type { LaunchProfile, ModelInfo, BenchmarkResult } from "../types/app";
import { DEFAULT_CONFIG } from "../types/config";
import type { LogLine, RuntimeSnapshot } from "../types/runtime";

export const MOCK_RUNTIME: RuntimeSnapshot = {
  state: "ready", uptimeSeconds: 1697, endpoint: "http://127.0.0.1:8080", backend: "llama.cpp (CUDA)", pid: 18424,
  processStartedAt: new Date(Date.now() - 1697_000).toISOString(),
  gpu: { name: "NVIDIA GeForce RTX 5080", utilization: 92, memoryUsedMiB: 14438, memoryTotalMiB: 16303, temperatureC: 65, powerW: 312, powerLimitW: 360, clockMHz: 2800 },
  cpu: { name: "AMD Ryzen 7 9800X3D", utilization: 28, threads: 16, clockMHz: 5200, temperatureC: 61 },
  memory: { usedMiB: 29800, totalMiB: 65536 }, generationTps: 47.8, promptTps: 121.4, activeRequests: 1, queuedRequests: 0, ttftMs: 312,
  contextUsed: 32768, contextTotal: 65536, metricsAvailable: true, slotsAvailable: true, healthStatus: 200,
  slots: [{ id: 0, state: "generating", contextUsed: 31000, contextTotal: 65536, generationTps: 48.1, taskId: 135 }, { id: 1, state: "idle", contextUsed: 0, contextTotal: 65536 }]
};

export const MOCK_LOGS: LogLine[] = [
  ["INFO","stdout","loading model from C:\\Models\\Example-Coder-30B-A3B-Q4_K_M.gguf"], ["INFO","stdout","CUDA0: total VRAM = 16384 MiB, available = 16201 MiB"],
  ["INFO","stdout","offloading 48 layers to CUDA"], ["INFO","stdout","KV cache: type = q8_0, size = 65536, offload = yes"], ["INFO","stdout","server listening on http://127.0.0.1:8080"], ["INFO","control","server ready"]
].map((x, i) => ({ id: `mock-${i}`, timestamp: new Date(Date.now() - (6-i)*1000).toISOString(), level: x[0] as LogLine["level"], source: x[1] as LogLine["source"], message: x[2] }));

export const MOCK_MODELS: ModelInfo[] = [
  { id: "m1", path: "C:\\Models\\Example-Coder-30B-A3B-Q4_K_M.gguf", fileName: "Example-Coder-30B-A3B-Q4_K_M.gguf", sizeBytes: 17.2*1024**3, modifiedAt: new Date(Date.now()-86400000).toISOString(), quantization: "Q4_K_M", architecture: "example-moe", parameterCount: "30B / 3B active", contextLength: 262144, modelName: "Example Coder 30B A3B" },
  { id: "m2", path: "C:\\Models\\Example-14B-Q6_K.gguf", fileName: "Example-14B-Q6_K.gguf", sizeBytes: 11.8*1024**3, modifiedAt: new Date(Date.now()-3*86400000).toISOString(), quantization: "Q6_K", architecture: "example-decoder", parameterCount: "14B", contextLength: 131072 },
  { id: "m3", path: "C:\\Models\\Example-27B-Q4_K_M.gguf", fileName: "Example-27B-Q4_K_M.gguf", sizeBytes: 15.4*1024**3, modifiedAt: new Date(Date.now()-5*86400000).toISOString(), quantization: "Q4_K_M", architecture: "example-decoder", parameterCount: "27B", contextLength: 131072 },
];

export const MOCK_PROFILES: LaunchProfile[] = [
  { id: "example-balanced", name: "Example model — Balanced", description: "Demonstration profile only", config: { ...DEFAULT_CONFIG, profileId: "example-balanced", profileName: "Example model — Balanced", modelPath: "C:\\Models\\Example-Coder-30B-A3B-Q4_K_M.gguf" }, createdAt: new Date(Date.now()-20*86400000).toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: new Date(Date.now()-300000).toISOString(), lastKnownGood: true },
  { id: "example-long", name: "Example model — Long context", config: { ...DEFAULT_CONFIG, profileId: "example-long", profileName: "Example model — Long context", modelPath: "C:\\Models\\Example-Coder-30B-A3B-Q4_K_M.gguf", ctxSize: 131072, cacheTypeK: "q4_0", cacheTypeV: "q4_0", parallel: 1 }, createdAt: new Date(Date.now()-10*86400000).toISOString(), updatedAt: new Date(Date.now()-86400000).toISOString(), lastKnownGood: false },
  { id: "example-fast", name: "Example model — Fast", config: { ...DEFAULT_CONFIG, profileId: "example-fast", profileName: "Example model — Fast", modelPath: "C:\\Models\\Example-Coder-30B-A3B-Q4_K_M.gguf", ctxSize: 32768, parallel: 1, batchSize: 4096 }, createdAt: new Date(Date.now()-6*86400000).toISOString(), updatedAt: new Date(Date.now()-2*86400000).toISOString(), lastKnownGood: true },
];

export const MOCK_BENCHMARKS: BenchmarkResult[] = [{ id: "b1", profileId: "example-balanced", profileName: "Example model — Balanced", createdAt: new Date(Date.now()-2*3600000).toISOString(), request: { profileId: "example-balanced", promptTokens: 2048, generationTokens: 512, runs: 3 }, samples: [1,2,3].map(run => ({ run, promptTps: 430+run*3, generationTps: 47.5+run*.2, ttftMs: 315-run*2, totalMs: 10800-run*50, vramPeakMiB: 15000, ramPeakMiB: 22900, gpuPeakPercent: 99 })), averages: { promptTps: 436, generationTps: 47.9, ttftMs: 311, totalMs: 10700, vramPeakMiB: 15000, ramPeakMiB: 22900, gpuPeakPercent: 99 } }];
