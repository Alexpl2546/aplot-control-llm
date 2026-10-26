import { describe, expect, it } from "vitest";
import { extractBenchmarkLaunchConfig, mergeBenchmarkLaunchConfig } from "../src/lib/benchmarkLaunchConfig";
import { rankProfileResults } from "../src/lib/benchmarkOptimizer";
import { DEFAULT_SETTINGS } from "../src/types/app";
import { MOCK_BENCHMARKS } from "../src/mocks/runtime";
import { TEST_CONFIG } from "./fixtures";
import type { StartRunRequest } from "../src/types/runtime";

const run: StartRunRequest = { runId: "trial:example", name: "Trial", engine: "llama_cpp", mode: "single", modelId: TEST_CONFIG.modelPath, contextTokens: TEST_CONFIG.ctxSize, launch: { args: ["--ctx-size", String(TEST_CONFIG.ctxSize)] } };
const wrapper = () => ({ run, editorConfiguration: { ...TEST_CONFIG, apiKey: "[redacted]", engineOptions: { llama_cpp: { routerApiKey: "[redacted]", future: 42 } } }, editorConfigurationSource: "caller" as const });

describe("benchmark editor configuration extraction", () => {
  it("supports legacy flat snapshots and labeled caller config without mutating evidence", () => {
    const evidence = wrapper(); const before = JSON.stringify(evidence);
    expect(extractBenchmarkLaunchConfig(TEST_CONFIG)?.ctxSize).toBe(TEST_CONFIG.ctxSize);
    expect(extractBenchmarkLaunchConfig(evidence)?.engineOptions?.llama_cpp).toEqual({ future: 42 });
    expect(extractBenchmarkLaunchConfig(evidence)?.apiKey).toBe("");
    expect(JSON.stringify(evidence)).toBe(before);
  });
  it("rejects bare run requests, malformed wrappers and mismatched actual context", () => {
    for (const snapshot of [run, { ...wrapper(), editorConfigurationSource: "unknown" }, { ...wrapper(), editorConfiguration: run }, { ...wrapper(), run: { ...run, contextTokens: run.contextTokens + 1 } }, { ...wrapper(), editorConfiguration: { ...TEST_CONFIG, extraArgs: "--api-key [redacted]" } }]) {
      expect(extractBenchmarkLaunchConfig(snapshot)).toBeUndefined();
    }
  });
  it("keeps current credentials and unknown fields when applying a redacted caller snapshot", () => {
    const current = { ...TEST_CONFIG, apiKey: "current-key", engineOptions: { llama_cpp: { routerApiKey: "current-router-key", retained: true }, qwfnfer: { qwfn: { ...DEFAULT_SETTINGS.qwfn, apiKey: "qwfn-key" } } } };
    const merged = mergeBenchmarkLaunchConfig(current, extractBenchmarkLaunchConfig(wrapper())!);
    expect(merged.apiKey).toBe("current-key");
    expect(merged.engineOptions?.llama_cpp).toEqual({ routerApiKey: "current-router-key", retained: true, future: 42 });
    expect(JSON.stringify(merged)).not.toContain("[redacted]");
  });
  it("ranks valid native wrappers and excludes authoritative-only evidence", () => {
    const valid = { ...MOCK_BENCHMARKS[0], id: "wrapped", meetsTargets: true, configSnapshot: { ...wrapper(), editorConfiguration: { ...wrapper().editorConfiguration, fit: false, parallel: 1 } } };
    const bare = { ...valid, id: "bare", configSnapshot: run };
    expect(rankProfileResults([bare, valid], "maxSpeed", 1).map(result => result.id)).toEqual(["wrapped"]);
  });
});
