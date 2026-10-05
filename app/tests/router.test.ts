import { describe, expect, it } from "vitest";
import { buildRouterArgs, buildRouterPreset, renderRouterCommand } from "../src/lib/router";
import { parseCapabilities } from "../src/lib/capabilities";
import { DEFAULT_CONFIG } from "../src/types/config";
import { DEFAULT_SETTINGS, type LaunchProfile } from "../src/types/app";

const help = `--model --alias --mmproj --lora --device --gpu-layers --flash-attn --fit --fit-target --fit-ctx
--kv-offload --no-kv-offload --cache-type-k --cache-type-v --split-mode --tensor-split --main-gpu
--ctx-size --batch-size --ubatch-size --parallel --threads --threads-batch --cont-batching --no-cont-batching
--host --port --api-key --ui --no-ui --no-webui --timeout --threads-http --metrics --slots --no-slots --props
--jinja --no-jinja --reasoning --reasoning-format --temp --top-k --top-p --min-p --typical-p
--repeat-penalty --repeat-last-n --frequency-penalty --presence-penalty --seed
--models-preset --models-max --models-autoload --no-models-autoload --log-verbosity --log-colors`;
const capabilities = parseCapabilities("llama.cpp build 10743", help);

function profile(name: string, patch: Partial<typeof DEFAULT_CONFIG> = {}): LaunchProfile {
  const config = { ...DEFAULT_CONFIG, profileId: name, profileName: name, modelPath: `C:\\Models\\${name}.gguf`, ...patch };
  return { id: name, name, config, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastKnownGood: false };
}

describe("router preset generation", () => {
  it("writes each saved profile as an independently addressable model route", () => {
    const presets = buildRouterPreset([
      profile("qwen-long", { ctxSize: 131072, cacheTypeK: "q4_0", extraArgs: "--n-cpu-moe 18 --no-mmproj --log-verbosity 4 --offline" }),
      profile("gemma-e4b", { mmprojPath: "C:\\Models\\vision projector.gguf" }),
    ], capabilities);

    expect(presets.content).toContain("[qwen-long]");
    expect(presets.content).toContain("model = C:\\Models\\qwen-long.gguf");
    expect(presets.content).toContain("c = 131072");
    expect(presets.content).toContain("ctk = q4_0");
    expect(presets.content).toContain("n-cpu-moe = 18");
    expect(presets.content).toContain("no-mmproj = true");
    expect(presets.content).toContain("[gemma-e4b]");
    expect(presets.content).toContain("mmproj = C:\\Models\\vision projector.gguf");
    expect(presets.content).toContain("load-on-startup = false");
    expect(presets.content.match(/log-verbosity = 4/g)).toHaveLength(1);
  });

  it("enables Jinja for router routes so OpenAI tool calls are accepted", () => {
    const presets = buildRouterPreset([profile("qwen-tools", { jinja: false })], capabilities);

    expect(presets.content).toContain("[qwen-tools]");
    expect(presets.content).toContain("jinja = true");
    expect(presets.content).not.toContain("jinja = false");
  });

  it("reports when the selected server cannot enable Jinja for tool calls", () => {
    const withoutJinja = {
      ...capabilities,
      jinja: false,
      rawArguments: capabilities.rawArguments.filter(flag => flag !== "--jinja" && flag !== "--no-jinja"),
      rawHelp: "--models-preset --models-max --models-autoload",
    };
    const presets = buildRouterPreset([profile("qwen-tools", { jinja: false })], withoutJinja);

    expect(presets.content).not.toContain("jinja = true");
    expect(presets.unsupportedParameters).toContain("parameters.jinja");
  });

  it("rejects empty, invalid, and duplicate API route names", () => {
    expect(() => buildRouterPreset([], capabilities)).toThrow(/at least one saved profile/i);
    expect(() => buildRouterPreset([profile("bad]name")], capabilities)).toThrow(/model ID/i);
    expect(() => buildRouterPreset([profile("Same"), profile("same")], capabilities)).toThrow(/unique/i);
    expect(() => buildRouterPreset([profile("missing", { modelPath: "" })], capabilities)).toThrow(/no GGUF/i);
  });

  it("uses the real router flags and does not expose the API key on the command line", () => {
    const settings = { ...DEFAULT_SETTINGS, routerHost: "192.168.1.117", routerPort: 8080, routerMaxLoadedModels: 1, routerApiKey: "secret-value" };
    const args = buildRouterArgs(settings, "C:\\App Data\\router-presets.ini", capabilities);
    expect(args).toEqual(expect.arrayContaining(["--models-preset", "C:\\App Data\\router-presets.ini", "--models-max", "1", "--models-autoload", "--host", "192.168.1.117", "--port", "8080", "--no-webui", "--metrics"]));
    expect(args).not.toContain("--api-key");
    const command = renderRouterCommand(DEFAULT_CONFIG, [profile("route")], settings, "C:\\App Data\\router-presets.ini", "powershell", capabilities);
    expect(command).toContain("# 1 profile routes");
    expect(command).not.toContain("secret-value");
  });

  it("blocks router mode when the detected executable lacks router support", () => {
    const old = parseCapabilities("old", "--model --host --port --models-dir");
    expect(() => buildRouterArgs(DEFAULT_SETTINGS, "router-presets.ini", old)).toThrow(/does not support router/i);
  });
});
