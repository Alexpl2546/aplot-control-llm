import type { ModelInfo, ServerEngine, StrataModelOption } from "../types/app";
import { isPrimaryModelFile, modelDisplayName } from "./models";

export const ENGINE_NAMES: Record<ServerEngine, string> = { llama_cpp: "llama.cpp", strata: "Strata" };
export interface EngineModel {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  architecture?: string;
  quantization?: string;
  contextLength?: number;
  sources: { llama_cpp?: ModelInfo; strata?: StrataModelOption };
}
export const pathKey = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLocaleLowerCase();
export function isLlamaModel(model: ModelInfo) {
  // qwen4exp is exposed through the verified Strata integration. The shared
  // llama.cpp runtime is PrismML, which cannot load this architecture.
  return Boolean(/\.gguf$/i.test(model.path) && model.architecture && !["clip", "mmproj", "qwen4exp"].includes(model.architecture) && model.metadata?.["general.type"] !== "adapter" && Number(model.metadata?.["split.no"] ?? 0) === 0 && isPrimaryModelFile(model));
}
export function buildEngineModels(ggufs: ModelInfo[], strata: StrataModelOption[]): EngineModel[] {
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
  return [...entries.values()];
}
export const supportsEngine = (model: EngineModel, engine: ServerEngine) => Boolean(model.sources[engine]);

// This identifies an unfinished Strata preparation, never a launchable model.
// qwen4exp requires Strata's tokenizer, native runtime and validated config.
export const needsStrataPreparation = (model: EngineModel) => !model.sources.strata
  && model.architecture === "qwen4exp" && /\.gguf$/i.test(model.path);

export function modelConfigurationEngine(model: EngineModel, current: ServerEngine | "", filter: "all" | ServerEngine, installed: readonly ServerEngine[] = ["llama_cpp", "strata"]): ServerEngine | undefined {
  if (filter !== "all" && installed.includes(filter) && supportsEngine(model, filter)) return filter;
  if (current && installed.includes(current) && supportsEngine(model, current)) return current;
  if (!current && filter === "all") return undefined;
  return installed.find(engine => supportsEngine(model, engine));
}

export function modelStoragePath(model: EngineModel): string | undefined {
  return model.sources.strata?.modelPath || model.sources.llama_cpp?.path || (/\.gguf$/i.test(model.path) ? model.path : undefined);
}
