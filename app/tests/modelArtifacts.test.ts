import { describe, expect, it } from "vitest";
import { artifactConsumersFromProfiles, removalPreviewSummary, type ArtifactRemovalPreview } from "../src/features/models/artifactCatalog";
import { DEFAULT_CONFIG } from "../src/types/config";

describe("artifact catalogue adapters", () => {
  it("keeps primary, mmproj, ngram, MTP, and adapter paths as separate consumers", () => {
    const consumers = artifactConsumersFromProfiles([
      {
        id: "infernix-profile",
        config: {
          ...DEFAULT_CONFIG,
          modelPath: "E:/weights/main.gguf",
          mmprojPath: "E:/weights/main-mmproj.gguf",
          engineOptions: {
            engine: "infernix",
            values: { ngramPath: "E:/weights/ngram", mtpPath: "E:/weights/draft-mtp.gguf" },
          },
        },
      },
    ]);
    expect(consumers).toEqual([
      { id: "infernix-profile", kind: "model", path: "E:/weights/main.gguf", active: false },
      { id: "infernix-profile", kind: "mmproj", path: "E:/weights/main-mmproj.gguf", active: false },
      { id: "infernix-profile", kind: "ngram", path: "E:/weights/ngram", active: false },
      { id: "infernix-profile", kind: "mtp", path: "E:/weights/draft-mtp.gguf", active: false },
    ]);
  });

  it("never turns a preview into a delete action", () => {
    const preview: ArtifactRemovalPreview = {
      artifactId: "artifact-1",
      files: [{ path: "E:/weights/main.gguf", sizeBytes: 100, candidateIfConfirmed: true, protectedBy: [] }],
      protectedFileCount: 0,
      candidateFileCount: 1,
      previewOnly: true,
      message: "Preview only. This API does not delete model files.",
    };
    expect(removalPreviewSummary(preview)).toEqual({
      canRemoveAnyFiles: false,
      protectedFileCount: 0,
      candidateFileCount: 1,
    });
  });

  it("retains paths from map-by-engine snapshots and deduplicates aliases", () => {
    const consumers = artifactConsumersFromProfiles([{
      id: "native-profile",
      config: {
        modelPath: "E:/weights/main.ninfer",
        engineOptions: {
          infernix: { modelPath: "e:\\weights\\main.ninfer", ngramPath: "E:/weights/ngram" },
          future_engine: { loraPaths: ["E:/weights/adapter.gguf"] },
        },
      },
    }], new Set(["native-profile"]));
    expect(consumers.map(consumer => consumer.path)).toEqual([
      "E:/weights/main.ninfer", "E:/weights/ngram", "E:/weights/adapter.gguf",
    ]);
    expect(consumers.every(consumer => consumer.active)).toBe(true);
  });
});
