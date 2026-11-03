import { describe, expect, it } from "vitest";
import { buildEngineModels, modelConfigurationEngine, modelStoragePath, needsStrataPreparation, pathKey, supportsEngine } from "../src/lib/engineModels";
import type { ModelInfo } from "../src/types/app";

const model: ModelInfo = { id: "gguf", path: "C:\\Models\\qwen.gguf", fileName: "qwen.gguf", sizeBytes: 100, modifiedAt: "", architecture: "qwen2" };

describe("engine model compatibility", () => {
  it("merges a GGUF with its prepared Strata config", () => {
    const entries = buildEngineModels([model], [{ configPath: "C:\\Strata\\strata-qwen.json", modelPath: "\\\\?\\C:\\Models\\qwen.gguf", modelName: "Qwen", contextLength: 4096 }]);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0].sources).sort()).toEqual(["llama_cpp", "strata"]);
    expect(pathKey("\\\\?\\C:\\Models\\qwen.gguf")).toBe(pathKey(model.path));
  });

  it("does not infer Strata support from a GGUF extension", () => {
    const [entry] = buildEngineModels([model], []);
    expect(supportsEngine(entry, "llama_cpp")).toBe(true);
    expect(supportsEngine(entry, "strata")).toBe(false);
  });

  it("hides auxiliary GGUFs from the library rather than just disabling launch", () => {
    for (const invalid of [{ ...model, architecture: "clip" }, { ...model, metadata: { "general.type": "adapter" } },
      ...["mmproj.gguf", "model-mmproj-f16.gguf", "mtp-draft.gguf", "dspark-DeepSeek-Q8_0.gguf", "DeepSeek-Engram-IQ4_NL.gguf"]
        .map(fileName => ({ ...model, fileName }))]) {
      expect(buildEngineModels([invalid], [])).toEqual([]);
    }
    expect(supportsEngine(buildEngineModels([{ ...model, architecture: undefined }], [])[0], "llama_cpp")).toBe(false);
  });

  it("shows one Strata model for a multi-file DeepSeek pack and preserves unrelated models", () => {
    const file = (fileName: string, sizeBytes: number): ModelInfo => ({ ...model, id: fileName, fileName, path: `C:/models/${fileName}`, sizeBytes });
    const header = { ...file("DeepSeek-UD-Q8_K_XL-00001-of-00009.gguf", 5), metadata: { "aplot.tensor_count": 0 } };
    const parts = [1, 2, 3, 4].map(i => file(`DeepSeek-IQ2_XS-0000${i}-of-00004.gguf`, 40));
    const engram = file("DeepSeek-Engram-IQ4_NL.gguf", 103);
    const draft = file("dspark-DeepSeek-Q8_0.gguf", 7);
    const pack = { configPath: "C:/Strata/deepseek.json", packPath: "C:/packs/deepseek", modelName: "DeepSeek", contextLength: 65536,
      modelFiles: [...parts, engram, draft].map(file => file.path.toUpperCase().replace(/\//g, "\\")), sizeBytes: 270 };
    const entries = buildEngineModels([model, header, ...parts, engram, draft], [pack, { ...pack, configPath: "C:/Strata/another-profile.json" }]);
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.name === "DeepSeek")).toMatchObject({ path: pack.packPath, sizeBytes: 270, sources: { strata: pack } });
    expect(entries.find(entry => entry.id === model.id)?.sources.llama_cpp).toEqual(model);
    expect(entries.find(entry => entry.name === "DeepSeek")?.sources.llama_cpp).toBeUndefined();
  });

  it("sums weight shards and retains a header when its full model weights exist", () => {
    const header = { ...model, fileName: "model-00001-of-00002.gguf", path: "C:/models/model-00001-of-00002.gguf", sizeBytes: 5, metadata: { "aplot.tensor_count": 0 } };
    const weights = { ...header, fileName: "model-00002-of-00002.gguf", path: "C:/models/model-00002-of-00002.gguf", sizeBytes: 100, metadata: { "aplot.tensor_count": 20 } };
    expect(buildEngineModels([header], [])).toEqual([]);
    expect(buildEngineModels([header, weights], [])).toHaveLength(1);
    expect(buildEngineModels([header, weights], [])[0].sizeBytes).toBe(105);
  });

  it("keeps experimental Strata GGUFs out of llama.cpp launch choices", () => {
    const native = { ...model, architecture: "qwen4exp" };
    const [entry] = buildEngineModels([native], [{ configPath: "C:\\Strata\\native.json", modelPath: native.path, modelName: "Native Qwen", contextLength: 65536 }]);
    expect(supportsEngine(entry, "strata")).toBe(true);
    expect(supportsEngine(entry, "llama_cpp")).toBe(false);
    expect(modelConfigurationEngine(entry, "llama_cpp", "all")).toBe("strata");
    expect(modelStoragePath(entry)).toBe(native.path);
  });

  it("distinguishes a downloaded qwen4exp from a prepared Strata model", () => {
    const native = { ...model, architecture: "qwen4exp" };
    const [downloaded] = buildEngineModels([native], []);
    expect(needsStrataPreparation(downloaded)).toBe(true);
    expect(supportsEngine(downloaded, "strata")).toBe(false);
    expect(supportsEngine(downloaded, "llama_cpp")).toBe(false);
    expect(modelConfigurationEngine(downloaded, "strata", "strata")).toBeUndefined();
    const [prepared] = buildEngineModels([native], [{ configPath: "strata-qwen.json", modelPath: native.path, modelName: "Qwen", contextLength: 8192 }]);
    expect(needsStrataPreparation(prepared)).toBe(false);
    expect(supportsEngine(prepared, "strata")).toBe(true);
    expect(needsStrataPreparation(buildEngineModels([model], [])[0])).toBe(false);
  });

  it("uses the filtered engine before the current compatible engine", () => {
    const [entry] = buildEngineModels([model], [{ configPath: "strata.json", modelPath: model.path, modelName: "Qwen", contextLength: 4096 }]);
    expect(modelConfigurationEngine(entry, "llama_cpp", "strata")).toBe("strata");
    expect(modelConfigurationEngine(entry, "strata", "all")).toBe("strata");
  });

  it("does not select a default engine when none is selected", () => {
    const [entry] = buildEngineModels([model], []);
    expect(modelConfigurationEngine(entry, "", "all")).toBeUndefined();
  });

  it("opens Strata native model storage and does not substitute a config folder", () => {
    const [native] = buildEngineModels([], [{ modelName: "Native", configPath: "C:\\Strata\\config.json", modelPath: "C:\\Models\\native-data", contextLength: 4096 }]);
    expect(modelStoragePath(native)).toBe("C:\\Models\\native-data");
    const [missing] = buildEngineModels([], [{ modelName: "Unknown", configPath: "C:\\Strata\\config.json", contextLength: 4096 }]);
    expect(modelStoragePath(missing)).toBeUndefined();
  });
});
