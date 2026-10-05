import { DEFAULT_CONFIG } from "../src/types/config";

export const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  binaryPath: "C:\\TestTools\\llama-server.exe",
  modelPath: "C:\\TestModels\\test-model.gguf",
  modelBytes: 8 * 1024 ** 3,
  modelAlias: "Test model",
};
