import type { EngineModel } from "./engineModels";

export type ModelUse = "coding" | "analysis" | "agents" | "chat" | "creative" | "documents";
export type ModelCapability = "text" | "vision" | "tools";
interface CatalogEntry { match: RegExp; creator: string; icon: string; source: string; uses: ModelUse[]; vision?: boolean; tools?: boolean; }
// Curated from publisher model cards; unknown families deliberately have no inferred capabilities.
const catalog: CatalogEntry[] = [
  { match: /ornith[\s._-]*1[._-]5/i, creator: "Ornith AI", icon: "ornith", source: "https://huggingface.co/ornith-ai/Ornith-1.5-9B", uses: ["coding", "agents", "analysis"], vision: true, tools: true },
  { match: /bonsai[\s._-]*2|ternary.bonsai.2/i, creator: "PrismML", icon: "prism", source: "https://prismml.com/news/prismml-launches-bonsai-2-27b", uses: ["coding", "analysis", "agents"], vision: true, tools: true },
  { match: /gemma[\s._-]*4/i, creator: "Google", icon: "google", source: "https://huggingface.co/google/gemma-4-12B-it", uses: ["coding", "analysis", "chat", "creative", "documents"], vision: true, tools: true },
  { match: /qwen[\s._-]*3[._-]?8.*flash|qwen4exp/i, creator: "Qwen", icon: "qwen", source: "https://github.com/QwenLM/Qwen3.8-Flash-Next", uses: ["coding", "analysis", "agents", "documents"], vision: true, tools: true },
  { match: /qwen[\s._-]*3[._-]?8/i, creator: "Qwen", icon: "qwen", source: "https://huggingface.co/Qwen/Qwen3.8-27B", uses: ["coding", "analysis", "agents", "documents"], vision: true, tools: true },
  { match: /gpt[\s._-]*oss/i, creator: "OpenAI", icon: "openai", source: "https://huggingface.co/openai/gpt-oss-20b", uses: ["coding", "analysis", "agents", "chat"], tools: true },
];

export function modelCatalog(model: Pick<EngineModel, "name" | "path" | "architecture">) {
  const identity = `${model.name} ${model.path.split(/[\\/]/).pop()} ${model.architecture ?? ""}`;
  return catalog.find(entry => entry.match.test(identity));
}
