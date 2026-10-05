import type { EngineModel } from "./engineModels";
import { pathKey } from "./engineModels";
import { modelCatalog } from "./modelCatalog";
import type { LaunchProfile } from "../types/app";

export function modelCardDetails(model: EngineModel, profiles: LaunchProfile[] = []) {
  const gguf = model.sources.llama_cpp ?? model.sources.qwfnfer ?? model.sources.ollama?.ggufModel;
  const parameters = Number(gguf?.metadata?.["general.parameter_count"] ?? gguf?.parameterCount);
  const sizeLabel = gguf?.metadata?.["general.size_label"];
  const parameterLabel = Number.isFinite(parameters) && parameters > 0
    ? `${Number((parameters / 1e9).toFixed(2))}B`
    : gguf?.parameterCount || (typeof sizeLabel === "string" ? sizeLabel : undefined) || model.sources.ollama?.details?.parameter_size || "—";
  const context = model.contextLength ?? model.sources.ollama?.context_length;
  const contextLabel = context && context > 0
    ? context >= 1024 ? `${Number((context / 1024).toFixed(1))}K` : String(context)
    : "—";
  const capabilities = model.sources.ollama?.capabilities ?? [];
  const metadataTags: unknown = gguf?.metadata?.["general.tags"];
  const tags = Array.isArray(metadataTags) ? metadataTags.filter((tag): tag is string => typeof tag === "string") : [];
  const format = gguf || /\.gguf$/i.test(model.path) ? "GGUF"
    : /\.safetensors$/i.test(model.path) ? "Safetensors"
    : model.sources.ollama ? "Ollama" : "—";
  const catalog = modelCatalog(model);
  const vision = capabilities.includes("vision") || tags.some(tag => ["image-text-to-text", "image-to-text", "visual-question-answering"].includes(tag)) || Boolean(catalog?.vision);
  const projectorConfigured = profiles.some(profile => pathKey(profile.config.modelPath) === pathKey(model.path) && Boolean(profile.config.mmprojPath?.trim()));
  const visionState = !vision ? "unknown" : capabilities.includes("vision") ? "ollama" : projectorConfigured ? "configured" : /gemma.?4.*12b|gemma4_unified/i.test(`${model.name} ${model.architecture}`) ? "runtime" : "projector";
  return {
    parameterLabel, contextLabel, format,
    catalog, vision, visionState,
    tools: capabilities.includes("tools") || tags.some(tag => ["tool-use", "function-calling"].includes(tag)) || Boolean(catalog?.tools),
    text: Object.values(model.sources).some(Boolean),
    monogram: (model.architecture || model.name).charAt(0).toUpperCase(),
  };
}
