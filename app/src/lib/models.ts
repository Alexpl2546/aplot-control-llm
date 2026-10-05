import type { ModelInfo } from "../types/app";

export function inferQuantization(fileName: string): string | undefined {
  const m = fileName.match(/(?:^|[-_.])(IQ\d(?:_[A-Z0-9]+)?|Q\d(?:_[A-Z0-9]+)?|BF16|F16|F32)(?:[-_.]|$)/i);
  return m?.[1]?.toUpperCase();
}
export function formatModelSize(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`; }
export function modelDisplayName(model: ModelInfo): string { return model.modelName && !/^(ours|model|unknown|hf)$/i.test(model.modelName) ? model.modelName : model.fileName.replace(/\.gguf$/i, ""); }
export function isPrimaryModelFile(model: ModelInfo): boolean {
  if (/^(mmproj|mtp)[-_]/i.test(model.fileName)) return false;
  const shard = model.fileName.match(/-(\d{5})-of-\d{5}\.gguf$/i);
  return !shard || Number(shard[1]) === 1;
}

export function modelLaunchMetadata(model: ModelInfo) {
  const meta = model.metadata ?? {}; const arch = model.architecture;
  const number = (key: string) => { const v = meta[key]; return typeof v === "number" ? v : undefined; };
  return {
    modelArchitecture: arch,
    modelParameterCount: model.parameterCount,
    modelQuantization: model.quantization,
    modelLayers: arch ? number(`${arch}.block_count`) : undefined,
    modelEmbeddingLength: arch ? number(`${arch}.embedding_length`) : undefined,
    modelHeadCount: arch ? number(`${arch}.attention.head_count`) : undefined,
    modelHeadCountKv: arch ? number(`${arch}.attention.head_count_kv`) : undefined,
  };
}
