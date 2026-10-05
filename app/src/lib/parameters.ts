import type { LaunchConfig, LlamaCapabilities } from "../types/config";

export type ParameterCategory = "model" | "hardware" | "context" | "server" | "sampling" | "advanced";
export type ParameterKind = "text" | "number" | "boolean" | "select" | "path" | "list";

export interface ParameterDefinition<K extends keyof LaunchConfig = keyof LaunchConfig> {
  key: K;
  category: ParameterCategory;
  groupKey?: string;
  kind: ParameterKind;
  cli?: string;
  cliAliases?: readonly string[];
  /** llama.cpp router preset key corresponding to this LaunchConfig field. */
  routerKey?: string;
  negativeCli?: string;
  valueMode?: "on-off";
  serializeValue?: (config: LaunchConfig) => unknown;
  labelKey: string;
  helpKey: string;
  restartRequired: boolean;
  capability?: keyof LlamaCapabilities;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  enabled?: (config: LaunchConfig) => boolean;
}

export const PARAMETER_REGISTRY: ParameterDefinition[] = [
  { key: "modelPath", category: "model", kind: "path", cli: "--model", routerKey: "model", labelKey: "parameters.modelPath", helpKey: "help.modelPath", restartRequired: true },
  { key: "modelAlias", category: "model", kind: "text", cli: "--alias", labelKey: "parameters.modelAlias", helpKey: "help.modelAlias", restartRequired: true },
  { key: "mmprojPath", category: "model", kind: "path", cli: "--mmproj", routerKey: "mmproj", labelKey: "parameters.mmproj", helpKey: "help.mmproj", restartRequired: true, capability: "mmproj" },
  { key: "loraPaths", category: "model", kind: "list", cli: "--lora", routerKey: "lora", labelKey: "parameters.lora", helpKey: "help.lora", restartRequired: true, capability: "lora" },
  { key: "device", category: "hardware", groupKey: "config.groups.hardware", kind: "text", cli: "--device", routerKey: "device", labelKey: "parameters.device", helpKey: "help.device", restartRequired: true, capability: "device" },
  { key: "gpuLayers", category: "hardware", groupKey: "config.groups.hardware", kind: "text", cli: "--gpu-layers", cliAliases: ["--n-gpu-layers"], routerKey: "ngl", labelKey: "parameters.gpuLayers", helpKey: "help.gpuLayers", restartRequired: true, capability: "gpuLayers" },
  { key: "flashAttention", category: "hardware", groupKey: "config.groups.hardware", kind: "select", cli: "--flash-attn", routerKey: "fa", labelKey: "parameters.flashAttention", helpKey: "help.flashAttention", restartRequired: true, capability: "flashAttention", options: ["auto", "on", "off"] },
  { key: "fit", category: "hardware", groupKey: "config.groups.hardware", kind: "boolean", cli: "--fit", routerKey: "fit", valueMode: "on-off", serializeValue: c => c.fit && c.splitMode !== "tensor", labelKey: "parameters.fit", helpKey: "help.fit", restartRequired: true, capability: "fit", enabled: c => c.splitMode !== "tensor" },
  { key: "fitTargetMiB", category: "hardware", groupKey: "config.groups.hardware", kind: "number", cli: "--fit-target", routerKey: "fit-target", labelKey: "parameters.fitTarget", helpKey: "help.fitTarget", restartRequired: true, capability: "fitTarget", min: 0, step: 128, enabled: c => c.fit && c.splitMode !== "tensor" },
  { key: "fitContextMin", category: "hardware", groupKey: "config.groups.hardware", kind: "number", cli: "--fit-ctx", routerKey: "fit-ctx", labelKey: "parameters.fitContext", helpKey: "help.fitContext", restartRequired: true, capability: "fitContext", min: 256, step: 256, enabled: c => c.fit && c.splitMode !== "tensor" },
  { key: "kvOffload", category: "hardware", groupKey: "config.groups.memoryKv", kind: "boolean", cli: "--kv-offload", routerKey: "kv-offload", negativeCli: "--no-kv-offload", labelKey: "parameters.kvOffload", helpKey: "help.kvOffload", restartRequired: true, capability: "kvOffload" },
  { key: "cacheTypeK", category: "hardware", groupKey: "config.groups.memoryKv", kind: "select", cli: "--cache-type-k", routerKey: "ctk", labelKey: "parameters.cacheTypeK", helpKey: "help.cacheTypeK", restartRequired: true },
  { key: "cacheTypeV", category: "hardware", groupKey: "config.groups.memoryKv", kind: "select", cli: "--cache-type-v", routerKey: "ctv", labelKey: "parameters.cacheTypeV", helpKey: "help.cacheTypeV", restartRequired: true },
  { key: "splitMode", category: "hardware", groupKey: "config.groups.multiGpu", kind: "select", cli: "--split-mode", routerKey: "split-mode", labelKey: "parameters.splitMode", helpKey: "help.splitMode", restartRequired: true, capability: "splitMode", options: ["none", "layer", "row", "tensor"] },
  { key: "tensorSplit", category: "hardware", groupKey: "config.groups.multiGpu", kind: "text", cli: "--tensor-split", routerKey: "tensor-split", labelKey: "parameters.tensorSplit", helpKey: "help.tensorSplit", restartRequired: true, capability: "tensorSplit", enabled: c => c.splitMode !== "none" },
  { key: "mainGpu", category: "hardware", groupKey: "config.groups.multiGpu", kind: "number", cli: "--main-gpu", routerKey: "main-gpu", labelKey: "parameters.mainGpu", helpKey: "help.mainGpu", restartRequired: true, min: 0 },
  { key: "ctxSize", category: "context", kind: "number", cli: "--ctx-size", routerKey: "c", labelKey: "parameters.ctxSize", helpKey: "help.ctxSize", restartRequired: true, min: 256, step: 256 },
  { key: "batchSize", category: "context", kind: "number", cli: "--batch-size", routerKey: "b", labelKey: "parameters.batchSize", helpKey: "help.batchSize", restartRequired: true, min: 1 },
  { key: "ubatchSize", category: "context", kind: "number", cli: "--ubatch-size", routerKey: "ub", labelKey: "parameters.ubatchSize", helpKey: "help.ubatchSize", restartRequired: true, min: 1 },
  { key: "parallel", category: "context", kind: "number", cli: "--parallel", routerKey: "np", labelKey: "parameters.parallel", helpKey: "help.parallel", restartRequired: true, min: 1, max: 64 },
  { key: "threads", category: "context", kind: "number", cli: "--threads", routerKey: "t", labelKey: "parameters.threads", helpKey: "help.threads", restartRequired: true, min: 1 },
  { key: "threadsBatch", category: "context", kind: "number", cli: "--threads-batch", routerKey: "tb", labelKey: "parameters.threadsBatch", helpKey: "help.threadsBatch", restartRequired: true, min: 1 },
  { key: "continuousBatching", category: "context", kind: "boolean", cli: "--cont-batching", routerKey: "cont-batching", negativeCli: "--no-cont-batching", labelKey: "parameters.contBatch", helpKey: "help.contBatch", restartRequired: true },
  { key: "host", category: "server", kind: "text", cli: "--host", labelKey: "parameters.host", helpKey: "help.host", restartRequired: true },
  { key: "port", category: "server", kind: "number", cli: "--port", labelKey: "parameters.port", helpKey: "help.port", restartRequired: true, min: 1, max: 65535 },
  { key: "apiKey", category: "server", kind: "text", cli: "--api-key", labelKey: "parameters.apiKey", helpKey: "help.apiKey", restartRequired: true, capability: "apiKey" },
  { key: "corsOrigins", category: "server", kind: "text", cli: "--cors-origins", labelKey: "parameters.corsOrigins", helpKey: "help.corsOrigins", restartRequired: true, capability: "cors" },
  { key: "corsMethods", category: "server", kind: "text", cli: "--cors-methods", labelKey: "parameters.corsMethods", helpKey: "help.corsMethods", restartRequired: true, capability: "cors" },
  { key: "corsHeaders", category: "server", kind: "text", cli: "--cors-headers", labelKey: "parameters.corsHeaders", helpKey: "help.corsHeaders", restartRequired: true, capability: "cors" },
  { key: "corsCredentials", category: "server", kind: "boolean", cli: "--cors-credentials", negativeCli: "--no-cors-credentials", labelKey: "parameters.corsCredentials", helpKey: "help.corsCredentials", restartRequired: true, capability: "cors" },
  { key: "webUi", category: "server", kind: "boolean", cli: "--ui", cliAliases: ["--webui"], negativeCli: "--no-ui", labelKey: "parameters.webUi", helpKey: "help.webUi", restartRequired: true, capability: "webUi" },
  { key: "timeoutSeconds", category: "server", kind: "number", cli: "--timeout", labelKey: "parameters.timeout", helpKey: "help.timeout", restartRequired: true, capability: "timeout", min: 1 },
  { key: "httpThreads", category: "server", kind: "number", cli: "--threads-http", labelKey: "parameters.httpThreads", helpKey: "help.httpThreads", restartRequired: true, capability: "threadsHttp", min: 1 },
  { key: "metrics", category: "server", kind: "boolean", cli: "--metrics", labelKey: "parameters.metrics", helpKey: "help.metrics", restartRequired: true, capability: "metrics" },
  { key: "slots", category: "server", kind: "boolean", cli: "--slots", negativeCli: "--no-slots", labelKey: "parameters.slots", helpKey: "help.slots", restartRequired: true, capability: "slots" },
  { key: "props", category: "server", kind: "boolean", cli: "--props", labelKey: "parameters.props", helpKey: "help.props", restartRequired: true, capability: "props" },
  { key: "jinja", category: "server", kind: "boolean", cli: "--jinja", routerKey: "jinja", negativeCli: "--no-jinja", labelKey: "parameters.jinja", helpKey: "help.jinja", restartRequired: true, capability: "jinja" },
  { key: "reasoning", category: "server", kind: "select", cli: "--reasoning", routerKey: "reasoning", labelKey: "parameters.reasoning", helpKey: "help.reasoning", restartRequired: true, capability: "reasoning", options: ["auto", "on", "off"] },
  { key: "reasoningFormat", category: "server", kind: "select", cli: "--reasoning-format", routerKey: "reasoning-format", labelKey: "parameters.reasoningFormat", helpKey: "help.reasoningFormat", restartRequired: true, capability: "reasoningFormat", options: ["auto", "none", "deepseek", "deepseek-legacy"] },
  { key: "temperature", category: "sampling", kind: "number", cli: "--temp", routerKey: "temp", labelKey: "parameters.temperature", helpKey: "help.temperature", restartRequired: true, min: 0, max: 2, step: 0.05 },
  { key: "topK", category: "sampling", kind: "number", cli: "--top-k", routerKey: "top-k", labelKey: "parameters.topK", helpKey: "help.topK", restartRequired: true, min: 0 },
  { key: "topP", category: "sampling", kind: "number", cli: "--top-p", routerKey: "top-p", labelKey: "parameters.topP", helpKey: "help.topP", restartRequired: true, min: 0, max: 1, step: 0.01 },
  { key: "minP", category: "sampling", kind: "number", cli: "--min-p", routerKey: "min-p", labelKey: "parameters.minP", helpKey: "help.minP", restartRequired: true, min: 0, max: 1, step: 0.01 },
  { key: "typicalP", category: "sampling", kind: "number", cli: "--typical-p", routerKey: "typical-p", labelKey: "parameters.typicalP", helpKey: "help.typicalP", restartRequired: true, min: 0, max: 1, step: 0.01 },
  { key: "repeatPenalty", category: "sampling", kind: "number", cli: "--repeat-penalty", routerKey: "repeat-penalty", labelKey: "parameters.repeatPenalty", helpKey: "help.repeatPenalty", restartRequired: true, min: 0, step: 0.01 },
  { key: "repeatLastN", category: "sampling", kind: "number", cli: "--repeat-last-n", routerKey: "repeat-last-n", labelKey: "parameters.repeatLastN", helpKey: "help.repeatLastN", restartRequired: true, min: 0 },
  { key: "frequencyPenalty", category: "sampling", kind: "number", cli: "--frequency-penalty", routerKey: "frequency-penalty", labelKey: "parameters.frequencyPenalty", helpKey: "help.frequencyPenalty", restartRequired: true, step: 0.01 },
  { key: "presencePenalty", category: "sampling", kind: "number", cli: "--presence-penalty", routerKey: "presence-penalty", labelKey: "parameters.presencePenalty", helpKey: "help.presencePenalty", restartRequired: true, step: 0.01 },
  { key: "seed", category: "sampling", kind: "number", cli: "--seed", routerKey: "seed", labelKey: "parameters.seed", helpKey: "help.seed", restartRequired: true },
  { key: "extraArgs", category: "advanced", kind: "text", labelKey: "parameters.extraArgs", helpKey: "help.extraArgs", restartRequired: true },
];

export function supportedParameters(capabilities: LlamaCapabilities) {
  return PARAMETER_REGISTRY.filter(parameter => isParameterAvailable(parameter, capabilities));
}

function flagsFor(parameter: ParameterDefinition) {
  return [parameter.cli, ...(parameter.cliAliases ?? []), parameter.negativeCli].filter((flag): flag is string => Boolean(flag));
}

function rawHelpHas(capabilities: LlamaCapabilities, flag: string) {
  return capabilities.rawArguments.includes(flag);
}

export function isParameterAvailable(parameter: ParameterDefinition, capabilities: LlamaCapabilities): boolean {
  if (!parameter.cli) return true;
  if (capabilities.rawHelp !== undefined) return flagsFor(parameter).some(flag => rawHelpHas(capabilities, flag));
  return parameter.capability ? Boolean(capabilities[parameter.capability]) : false;
}

export function isParameterValueAvailable(
  parameter: ParameterDefinition,
  config: LaunchConfig,
  capabilities: LlamaCapabilities,
): boolean {
  if (!parameter.cli || capabilities.rawHelp === undefined) return Boolean(parameter.capability && capabilities[parameter.capability]);
  if (parameter.valueMode) return rawHelpHas(capabilities, parameter.cli);

  const value = config[parameter.key] as unknown;
  if (typeof value === "boolean" && !value && parameter.negativeCli) {
    return rawHelpHas(capabilities, parameter.negativeCli);
  }
  if (typeof value === "boolean" && !value) return isParameterAvailable(parameter, capabilities);
  return [parameter.cli, ...(parameter.cliAliases ?? [])].some(flag => rawHelpHas(capabilities, flag));
}

export function selectedCliFlag(parameter: ParameterDefinition, config: LaunchConfig, capabilities?: Partial<LlamaCapabilities>): string | undefined {
  if (!parameter.cli) return undefined;
  const value = parameter.serializeValue ? parameter.serializeValue(config) : config[parameter.key] as unknown;

  if (parameter.valueMode) {
    if (capabilities?.rawHelp !== undefined) {
      return [parameter.cli, ...(parameter.cliAliases ?? [])].find(flag => capabilities.rawArguments?.includes(flag));
    }
    return parameter.capability && capabilities?.[parameter.capability] === true ? parameter.cli : undefined;
  }

  if (typeof value === "boolean" && !value) {
    if (!parameter.negativeCli) return undefined;
    if (capabilities?.rawHelp !== undefined) {
      return capabilities.rawArguments?.includes(parameter.negativeCli) ? parameter.negativeCli : undefined;
    }
    return parameter.capability && capabilities?.[parameter.capability] === true ? parameter.negativeCli : undefined;
  }

  const candidates = [parameter.cli, ...(parameter.cliAliases ?? [])];
  if (capabilities?.rawHelp !== undefined) {
    return candidates.find(flag => capabilities.rawArguments?.includes(flag));
  }
  if (!parameter.capability || capabilities?.[parameter.capability] !== true) return undefined;
  return candidates[0];
}
