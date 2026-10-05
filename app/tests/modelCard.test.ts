import { describe, expect, it } from "vitest";
import { modelCardDetails } from "../src/lib/modelCard";
import type { EngineModel } from "../src/lib/engineModels";
import { memoryHardwareSummary } from "../src/lib/memoryHardware";
import { DEFAULT_CONFIG } from "../src/types/config";

const model: EngineModel = { id: "one", name: "Vision Tools Creative 12B", path: "example.gguf", sizeBytes: 1024, sources: {} };

describe("model card evidence", () => {
  it("keeps base-family evidence distinct from local Vision readiness", () => {
    const qwen = { ...model, name: "Qwen38 Ara v5", path: "C:/models/qwen.gguf" };
    expect(modelCardDetails(qwen)).toMatchObject({ vision: true, visionState: "projector", catalog: { creator: "Qwen" } });
    const profile = { id: "p", name: "p", createdAt: "", updatedAt: "", config: { ...DEFAULT_CONFIG, modelPath: "c:\\models\\qwen.gguf", mmprojPath: "C:/models/mmproj.gguf" } };
    expect(modelCardDetails(qwen, [profile]).visionState).toBe("configured");
    expect(modelCardDetails(qwen, [{ ...profile, config: { ...profile.config, modelPath: "other.gguf" } }]).visionState).toBe("projector");
    expect(modelCardDetails({ ...qwen, name: "Gemma-4-12B-It" }).visionState).toBe("runtime");
    expect(modelCardDetails({ ...qwen, name: "Qwen3.8-Flash-Next" }).catalog?.source).toContain("Flash-Next");
  });
  it("recognizes derived publishers before their base architecture", () => {
    const bonsai = modelCardDetails({ ...model, name: "Ternary-Bonsai-2-27B", architecture: "qwen38" });
    expect(bonsai.catalog?.creator).toBe("PrismML");
    expect(bonsai.catalog?.uses).toContain("agents");
    expect(modelCardDetails({ ...model, name: "Gemma 4 26B" }).catalog?.uses).toContain("creative");
  });
  it("does not invent parameters, context or capabilities from a model name", () => {
    expect(modelCardDetails(model)).toMatchObject({ parameterLabel: "—", contextLabel: "—", format: "GGUF", vision: false, tools: false, text: false });
  });
  it("uses declared Ollama metadata and handles small contexts", () => {
    const source = { name: "example", size: 1024, modified_at: "", digest: "", capabilities: ["completion", "vision", "tools"], context_length: 512, details: { parameter_size: "12B" } };
    expect(modelCardDetails({ ...model, path: "example", sources: { ollama: source } })).toMatchObject({ parameterLabel: "12B", contextLabel: "512", format: "Ollama", text: true, vision: true, tools: true });
    expect(modelCardDetails({ ...model, contextLength: 131072, sources: { ollama: source } }).contextLabel).toBe("128K");
  });
  it("retains the formatted GGUF parameter count supplied by the native scanner", () => {
    const gguf = { id: "one", path: "example.gguf", fileName: "example.gguf", sizeBytes: 1024, modifiedAt: "", parameterCount: "12B" };
    expect(modelCardDetails({ ...model, sources: { llama_cpp: gguf } }).parameterLabel).toBe("12B");
    expect(modelCardDetails({ ...model, sources: { llama_cpp: { ...gguf, metadata: { "general.parameter_count": 12e9 } } } }).parameterLabel).toBe("12B");
    expect(modelCardDetails({ ...model, sources: { llama_cpp: { ...gguf, parameterCount: undefined, metadata: { "general.size_label": "26B-A4B" } } } }).parameterLabel).toBe("26B-A4B");
  });
  it("reads explicit capability tags from GGUF JSON without assuming capabilities for ambiguous tags", () => {
    const metadata = JSON.parse('{"general.tags":["image-text-to-text","function-calling"]}');
    const gguf = { id: "one", path: "example.gguf", fileName: "example.gguf", sizeBytes: 1024, modifiedAt: "", metadata };
    expect(modelCardDetails({ ...model, sources: { llama_cpp: gguf } })).toMatchObject({ vision: true, tools: true });
    gguf.metadata = { "general.tags": ["any-to-any", "assistant", "creative"] };
    expect(modelCardDetails({ ...model, sources: { llama_cpp: gguf } })).toMatchObject({ vision: false, tools: false });
  });
});

describe("installed memory summary", () => {
  it("groups identical DIMMs and preserves mixed capacities and speeds", () => {
    const dimm = { capacityMiB: 32768, memoryType: "DDR5", partNumber: "F5-6400J3239G32G", speedMtps: 6400 };
    expect(memoryHardwareSummary([dimm, dimm])).toEqual({ name: "DDR5 · F5-6400J3239G32G", capacity: "2 × 32 GB", speed: "6400 MT/s" });
    expect(memoryHardwareSummary([dimm, { capacityMiB: 16384, speedMtps: 4800 }])).toMatchObject({ capacity: "1 × 32 GB + 1 × 16 GB", speed: "6400 MT/s / 4800 MT/s" });
    expect(memoryHardwareSummary()).toEqual({ name: "", capacity: "", speed: "" });
  });
});
