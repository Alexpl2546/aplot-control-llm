import type { ModelInfo, ServerEngine, StrataModelOption } from "../types/app";
import type { OllamaModel } from "../services/ollama";
import { isPrimaryModelFile, modelDisplayName } from "./models";

export const ENGINE_NAMES: Record<ServerEngine, string> = { llama_cpp: "llama.cpp", strata: "Strata", ollama: "Ollama", qwfnfer: "QwFNfer" };
export interface EngineModel {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  architecture?: string;
  quantization?: string;
  contextLength?: number;
  sources: { llama_cpp?: ModelInfo; strata?: StrataModelOption; ollama?: OllamaModel; qwfnfer?: ModelInfo };
}
export const pathKey = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLocaleLowerCase();
export function isLlamaModel(model: ModelInfo) {
  // qwen4exp is exposed through the verified Strata integration. The shared
  // llama.cpp runtime is PrismML, which cannot load this architecture.
  return Boolean(model.architecture && !["clip", "mmproj", "qwen4exp"].includes(model.architecture) && model.metadata?.["general.type"] !== "adapter" && Number(model.metadata?.["split.no"] ?? 0) === 0 && isPrimaryModelFile(model));
}
export function buildEngineModels(ggufs: ModelInfo[], strata: StrataModelOption[], ollama: OllamaModel[]): EngineModel[] {
  const entries = new Map<string, EngineModel>();
  for (const model of ggufs.filter(isPrimaryModelFile)) {
    entries.set(pathKey(model.path), { id: model.id, name: modelDisplayName(model), path: model.path, sizeBytes: model.sizeBytes, architecture: model.architecture, quantization: model.quantization, contextLength: model.contextLength, sources: isLlamaModel(model) ? { llama_cpp: model } : {} });
  }
  for (const model of strata) {
    const key = pathKey(model.modelPath || model.configPath);
    const entry = entries.get(key) ?? { id: `strata:${key}`, name: model.modelName, path: model.modelPath || model.configPath, sizeBytes: 0, contextLength: model.contextLength, sources: {} };
    entry.sources.strata ??= model;
    entries.set(key, entry);
  }
  for (const model of ggufs.filter(model => model.architecture === "qwen4exp" && isPrimaryModelFile(model) && model.metadata?.["general.type"] !== "adapter" && model.metadata?.["general.type"] !== "mtp" && Number(model.metadata?.["split.no"] ?? 0) === 0)) {
    const entry = entries.get(pathKey(model.path));
    if (entry) entry.sources.qwfnfer = model;
  }
  for (const model of ollama.filter(model => !model.remote_host && !model.name.endsWith("-cloud") && model.capabilities?.includes("completion"))) {
    let key = pathKey(model.sourcePath || model.ggufModel?.path || `ollama:${model.name}`);
    if (entries.get(key)?.sources.ollama) key = `ollama:${model.name}`;
    const gguf = model.ggufModel;
    const entry = entries.get(key) ?? { id: `ollama:${model.name}`, name: model.name, path: gguf?.path || model.name, sizeBytes: model.size, architecture: gguf?.architecture, quantization: model.details?.quantization_level, contextLength: model.context_length, sources: {} };
    entry.sources.ollama = model;
    if (gguf && isLlamaModel(gguf) && !entry.sources.llama_cpp) entry.sources.llama_cpp = gguf;
    entries.set(key, entry);
  }
  return [...entries.values()];
}
export const supportsEngine = (model: EngineModel, engine: ServerEngine) => Boolean(model.sources[engine]);

export function modelConfigurationEngine(model: EngineModel, current: ServerEngine, filter: "all" | ServerEngine): ServerEngine | undefined {
  if (filter !== "all" && supportsEngine(model, filter)) return filter;
  if (supportsEngine(model, current)) return current;
  return (["llama_cpp", "strata", "ollama", "qwfnfer"] as const).find(engine => supportsEngine(model, engine));
}

export function modelStoragePath(model: EngineModel): string | undefined {
  return model.sources.strata?.modelPath || model.sources.llama_cpp?.path || model.sources.ollama?.ggufModel?.path || (/\.gguf$/i.test(model.path) ? model.path : undefined);
}
