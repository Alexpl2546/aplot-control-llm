import { describe, expect, it } from "vitest";
import { buildEngineModels, modelConfigurationEngine, modelStoragePath, pathKey, supportsEngine } from "../src/lib/engineModels";
import type { ModelInfo } from "../src/types/app";

const model: ModelInfo = { id: "gguf", path: "C:\\Models\\qwen.gguf", fileName: "qwen.gguf", sizeBytes: 100, modifiedAt: "", architecture: "qwen2" };
describe("engine model compatibility", () => {
  it("merges a GGUF with its prepared Strata config and registered Ollama tag", () => {
    const entries = buildEngineModels([model], [{ configPath: "C:\\Strata\\strata-qwen.json", modelPath: "\\\\?\\C:\\Models\\qwen.gguf", modelName: "Qwen", contextLength: 4096 }], [{ name: "qwen:local", size: 100, capabilities: ["completion"], sourcePath: model.path }]);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0].sources).sort()).toEqual(["llama_cpp", "ollama", "strata"]);
    expect(pathKey("\\\\?\\C:\\Models\\qwen.gguf")).toBe(pathKey(model.path));
  });
  it("does not infer Ollama or Strata support from a GGUF extension", () => {
    const [entry] = buildEngineModels([model], [], []);
    expect(supportsEngine(entry, "llama_cpp")).toBe(true);
    expect(supportsEngine(entry, "ollama")).toBe(false);
    expect(supportsEngine(entry, "strata")).toBe(false);
  });
  it("keeps aliases sharing one Ollama blob individually selectable", () => {
    const entries = buildEngineModels([], [], ["first:latest", "second:latest"].map(name => ({ name, size: 100, capabilities: ["completion"], ggufModel: model })));
    expect(entries.map(entry => entry.sources.ollama?.name)).toEqual(["first:latest", "second:latest"]);
  });
  it("excludes cloud and embedding models from generation choices", () => {
    expect(buildEngineModels([], [], [{ name: "embed:latest", size: 1, capabilities: ["embedding"] }, { name: "remote-cloud", size: 1, capabilities: ["completion"] }])).toEqual([]);
  });
  it("does not offer an adapter, projector or unreadable GGUF to llama.cpp", () => {
    for (const invalid of [{ ...model, architecture: "clip" }, { ...model, architecture: undefined }, { ...model, metadata: { "general.type": "adapter" } }]) {
      expect(supportsEngine(buildEngineModels([invalid], [], [])[0], "llama_cpp")).toBe(false);
    }
  });
  it("keeps experimental Strata GGUFs out of llama.cpp launch choices", () => {
    const native = { ...model, architecture: "qwen4exp" };
    const [entry] = buildEngineModels([native], [{ configPath: "C:\\Strata\\native.json", modelPath: native.path, modelName: "Native Qwen", contextLength: 65536 }], []);
    expect(supportsEngine(entry, "strata")).toBe(true);
    expect(supportsEngine(entry, "qwfnfer")).toBe(true);
    expect(supportsEngine(entry, "llama_cpp")).toBe(false);
    expect(supportsEngine(entry, "ollama")).toBe(false);
    expect(modelConfigurationEngine(entry, "llama_cpp", "all")).toBe("strata");
    expect(modelStoragePath(entry)).toBe(native.path);
  });
  it("uses the filtered engine before the current compatible engine", () => {
    const [entry] = buildEngineModels([model], [], [{ name: "qwen:local", size: 100, sourcePath: model.path, capabilities: ["completion"] }]);
    expect(modelConfigurationEngine(entry, "llama_cpp", "ollama")).toBe("ollama");
    expect(modelConfigurationEngine(entry, "ollama", "all")).toBe("ollama");
  });
  it("offers only a main qwen4exp shard to QwFNfer", () => {
    expect(supportsEngine(buildEngineModels([model], [], [])[0], "qwfnfer")).toBe(false);
    for (const metadata of [{ "general.type": "adapter" }, { "split.no": 1 }]) {
      const [entry] = buildEngineModels([{ ...model, architecture: "qwen4exp", metadata }], [], []);
      expect(supportsEngine(entry, "qwfnfer")).toBe(false);
    }
  });
  it("opens Strata native model storage and does not substitute a config folder", () => {
    const [native] = buildEngineModels([], [{ modelName: "Native", configPath: "C:\\Strata\\config.json", modelPath: "C:\\Models\\native-data", contextLength: 4096 }], []);
    expect(modelStoragePath(native)).toBe("C:\\Models\\native-data");
    const [missing] = buildEngineModels([], [{ modelName: "Unknown", configPath: "C:\\Strata\\config.json", contextLength: 4096 }], []);
    expect(modelStoragePath(missing)).toBeUndefined();
  });
});
