import { describe, expect, it } from "vitest";
import { withConfiguredBinary } from "../src/lib/profileConfig";
import { DEFAULT_CONFIG } from "../src/types/config";
import { TEST_CONFIG } from "./fixtures";

describe("withConfiguredBinary", () => {
  it("uses the binary selected in Settings for a legacy profile", () => {
    const configured = withConfiguredBinary(TEST_CONFIG, "C:\\llama\\llama-server.exe");
    expect(configured.binaryPath).toBe("C:\\llama\\llama-server.exe");
    expect(configured.modelPath).toBe(TEST_CONFIG.modelPath);
    expect(DEFAULT_CONFIG.binaryPath).toBe("");
    expect(DEFAULT_CONFIG.modelPath).toBe("");
  });

  it("keeps a profile binary when no Settings path is configured", () => {
    expect(withConfiguredBinary(TEST_CONFIG, "")).toBe(TEST_CONFIG);
    expect(withConfiguredBinary(TEST_CONFIG, "   ")).toBe(TEST_CONFIG);
  });
});
