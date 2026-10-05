export type GpuLayers = "auto" | "all" | number;
export type FlashAttention = "auto" | "on" | "off";
export type SplitMode = "none" | "layer" | "row" | "tensor";
export type KvCacheType = "f32" | "f16" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
export type ReasoningMode = "auto" | "on" | "off";
export type ReasoningFormat = "auto" | "none" | "deepseek" | "deepseek-legacy";

export interface LlamaCapabilities {
  version: string;
  build?: string;
  commit?: string;
  rawVersion?: string;
  rawHelp?: string;
  device: boolean;
  gpuLayers: boolean;
  flashAttention: boolean;
  kvCacheTypes: KvCacheType[];
  fit: boolean;
  fitTarget: boolean;
  fitContext: boolean;
  metrics: boolean;
  slots: boolean;
  tensorSplit: boolean;
  splitMode: boolean;
  kvOffload: boolean;
  modelsRouter: boolean;
  props: boolean;
  reasoning: boolean;
  reasoningFormat: boolean;
  jinja: boolean;
  apiKey: boolean;
  cors: boolean;
  uiConfig: boolean;
  webUi: boolean;
  timeout: boolean;
  threadsHttp: boolean;
  lora: boolean;
  mmproj: boolean;
  rawArguments: string[];
}

export interface LaunchConfig {
  engine?: "llama_cpp" | "strata" | "ollama" | "qwfnfer";
  engineModel?: string;
  profileId: string;
  profileName: string;
  binaryPath: string;
  modelPath: string;
  modelBytes?: number;
  modelParameterCount?: string;
  modelQuantization?: string;
  modelAlias?: string;
  modelArchitecture?: string;
  modelLayers?: number;
  modelEmbeddingLength?: number;
  modelHeadCount?: number;
  modelHeadCountKv?: number;
  mmprojPath?: string;
  loraPaths: string[];
  gpuLayers: GpuLayers;
  device: string;
  flashAttention: FlashAttention;
  fit: boolean;
  fitTargetMiB: number;
  fitContextMin: number;
  kvOffload: boolean;
  cacheTypeK: KvCacheType;
  cacheTypeV: KvCacheType;
  ctxSize: number;
  batchSize: number;
  ubatchSize: number;
  parallel: number;
  threads?: number;
  threadsBatch?: number;
  continuousBatching: boolean;
  splitMode: SplitMode;
  tensorSplit: string;
  mainGpu: number;
  host: string;
  port: number;
  apiKey?: string;
  corsOrigins: string;
  corsMethods: string;
  corsHeaders: string;
  corsCredentials: boolean;
  metrics: boolean;
  slots: boolean;
  props: boolean;
  webUi: boolean;
  timeoutSeconds?: number;
  httpThreads?: number;
  jinja: boolean;
  reasoning: ReasoningMode;
  reasoningFormat: ReasoningFormat;
  temperature: number;
  topK: number;
  topP: number;
  minP: number;
  typicalP: number;
  repeatPenalty: number;
  repeatLastN: number;
  frequencyPenalty: number;
  presencePenalty: number;
  seed: number;
  extraArgs: string;
}

export const DEFAULT_CONFIG: LaunchConfig = {
  profileId: "new-profile",
  profileName: "New profile",
  binaryPath: "",
  modelPath: "",
  mmprojPath: "",
  loraPaths: [],
  gpuLayers: "auto",
  device: "CUDA0",
  flashAttention: "auto",
  fit: true,
  fitTargetMiB: 1024,
  fitContextMin: 4096,
  kvOffload: true,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  ctxSize: 65536,
  batchSize: 2048,
  ubatchSize: 512,
  parallel: 2,
  continuousBatching: true,
  splitMode: "none",
  tensorSplit: "",
  mainGpu: 0,
  host: "127.0.0.1",
  port: 8080,
  apiKey: "",
  corsOrigins: "",
  corsMethods: "GET,POST,DELETE,OPTIONS",
  corsHeaders: "*",
  corsCredentials: false,
  metrics: true,
  slots: true,
  props: false,
  webUi: true,
  jinja: true,
  reasoning: "auto",
  reasoningFormat: "auto",
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  typicalP: 1,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: -1,
  extraArgs: "",
};

export const DEFAULT_CAPABILITIES: LlamaCapabilities = {
  version: "unknown",
  device: false,
  gpuLayers: false,
  flashAttention: false,
  kvCacheTypes: [],
  fit: false,
  fitTarget: false,
  fitContext: false,
  metrics: false,
  slots: false,
  tensorSplit: false,
  splitMode: false,
  kvOffload: false,
  modelsRouter: false,
  props: false,
  reasoning: false,
  reasoningFormat: false,
  jinja: false,
  apiKey: false,
  cors: false,
  uiConfig: false,
  webUi: false,
  timeout: false,
  threadsHttp: false,
  lora: false,
  mmproj: false,
  rawArguments: [],
};
