import { describe, expect, it } from "vitest";
import { modelsForDownload, profileEnginesForModel } from "../src/features/modelDownloads/profileChoices";
import type { EngineModel } from "../src/lib/engineModels";
import type { DownloadTask } from "../src/features/modelDownloads/types";
import type { ModelInfo } from "../src/types/app";

function task(finalPath: string, installedPath?: string): DownloadTask {
  return {
    id: "download-1", sequence: 1, state: "completed",
    plan: { planId: "plan-1", source: "owner/model", repoId: "owner/model", revision: "main", files: [], destination: "models", finalPath, totalBytes: 10, availableBytes: 100, warnings: [] },
    downloadedBytes: 10, totalBytes: 10, speedBytesPerSecond: 0,
    createdAt: "2026-10-22T12:00:00.000Z", updatedAt: "2026-10-22T12:00:01.000Z", installedPath,
  };
}

function llamaModel(id: string, path: string): EngineModel {
  const source: ModelInfo = { id, path, fileName: path.split(/[\\/]/).at(-1)!, sizeBytes: 10, modifiedAt: "", architecture: "qwen2" };
  return { id, name: id, path, sizeBytes: 10, sources: { llama_cpp: source } };
}

describe("download profile choices", () => {
  it("matches models inside the installed download folder without matching sibling paths", () => {
    const downloaded = llamaModel("downloaded", "C:\\Models\\repo\\weights.gguf");
    const sibling = llamaModel("sibling", "C:\\Models\\repo-old\\weights.gguf");

    expect(modelsForDownload(task("C:\\Models\\repo"), [downloaded, sibling])).toEqual([downloaded]);
  });

  it("matches the reported installed path as well as the planned final folder", () => {
    const downloaded = llamaModel("downloaded", "C:\\Models\\repo\\weights.gguf");
    const other = llamaModel("other", "D:\\Models\\other.gguf");

    expect(modelsForDownload(task("C:\\Models\\repo", "\\\\?\\C:\\Models\\repo\\weights.gguf"), [downloaded, other])).toEqual([downloaded]);
  });

  it("offers only explicitly supported and installed engines", () => {
    const llamaOnly = llamaModel("downloaded", "C:\\Models\\repo\\weights.gguf");
    const strataModel: EngineModel = {
      ...llamaOnly,
      sources: { ...llamaOnly.sources, strata: { configPath: "C:\\Strata\\repo.json", modelPath: llamaOnly.path, modelName: "Downloaded", contextLength: 4096 } },
    };

    expect(profileEnginesForModel(llamaOnly, ["llama_cpp", "strata"])).toEqual(["llama_cpp"]);
    expect(profileEnginesForModel(strataModel, ["strata"])).toEqual(["strata"]);
    expect(profileEnginesForModel(llamaOnly, ["strata"])).toEqual([]);
  });
});
