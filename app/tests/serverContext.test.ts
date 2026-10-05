import { describe, expect, it } from "vitest";
import { serverContextSize, strataRuntimeConfig } from "../src/lib/serverContext";
import { DEFAULT_SETTINGS } from "../src/types/app";
import { DEFAULT_CONFIG } from "../src/types/config";

const config = { ...DEFAULT_CONFIG, ctxSize: 65536 };
const settings = { ...DEFAULT_SETTINGS, serverEngine: "strata" as const, strataConfigPath: "C:/Strata/strata-iq3_s-200074.json" };
const strataModels = [
  { configPath: settings.strataConfigPath, modelName: "Qwen IQ3_S · 200,074 context", contextLength: 200074 },
  { configPath: "C:/Strata/strata-iq3_s-131072.json", modelName: "Qwen IQ3_S · 131K context", contextLength: 131072 },
];
const selected = { config, settings, strataModels };

describe("server context follows the selected or running engine", () => {
  it("uses the selected Strata JSON context when stopped, ignoring stale metrics and llama settings", () => {
    expect(serverContextSize({ ...selected, runtime: { state: "stopped", contextTotal: 65536 }, runningEngine: "llama_cpp", runningConfig: config })).toBe(200074);
    expect(serverContextSize({ ...selected, settings: { ...settings, strataConfigPath: strataModels[1].configPath }, runtime: { state: "stopped", contextTotal: 65536 } })).toBe(131072);
  });

  it("keeps the launched context during loading and prefers actual metrics once ready", () => {
    const runningConfig = strataRuntimeConfig(config, settings, strataModels);
    const changedSelection = { ...selected, settings: { ...settings, strataConfigPath: strataModels[1].configPath }, runningEngine: "strata" as const, runningConfig };
    expect(serverContextSize({ ...changedSelection, runtime: { state: "loading", contextTotal: 65536 } })).toBe(200074);
    expect(serverContextSize({ ...changedSelection, runtime: { state: "busy", contextTotal: 198000 } })).toBe(198000);
    expect(serverContextSize({ ...changedSelection, runtime: { state: "ready", contextTotal: 0 } })).toBe(200074);
  });

  it("does not present a llama default as an unknown Strata configuration", () => {
    expect(serverContextSize({ ...selected, strataModels: [], runtime: { state: "stopped", contextTotal: 0 } })).toBe(0);
    expect(serverContextSize({ ...selected, runtime: { state: "crashed", contextTotal: 65536 }, runningConfig: config })).toBe(200074);
  });

  it("retains engine-specific context for llama.cpp, Ollama and QwFNfer", () => {
    for (const [serverEngine, expected] of [["llama_cpp", 65536], ["ollama", 32768], ["qwfnfer", 262144]] as const) {
      expect(serverContextSize({ ...selected, settings: { ...settings, serverEngine, ollamaContext: 32768, qwfn: { ...settings.qwfn, context: 262144 } }, runtime: { state: "stopped", contextTotal: 131072 } })).toBe(expected);
    }
  });
});
