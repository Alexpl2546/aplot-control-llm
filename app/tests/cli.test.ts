import { describe, expect, it } from "vitest";
import { buildServerArgs, renderCommand, splitExtraArgs } from "../src/lib/cli";
import { parseCapabilities } from "../src/lib/capabilities";
import { TEST_CONFIG } from "./fixtures";
const help = `--model --alias --mmproj --lora --device --gpu-layers --flash-attn --fit --fit-target --fit-ctx
--kv-offload --no-kv-offload --cache-type-k q8_0 q4_0 f16 --cache-type-v q8_0 q4_0 f16
--split-mode --tensor-split --main-gpu --ctx-size --batch-size --ubatch-size --parallel --threads --threads-batch
--cont-batching --no-cont-batching --host --port --api-key --cors-origins --cors-methods --cors-headers
--cors-credentials --no-cors-credentials --ui --no-ui --timeout --threads-http --metrics --slots --no-slots --props
--jinja --no-jinja --reasoning --reasoning-format --temp --top-k --top-p --min-p --typical-p
--repeat-penalty --repeat-last-n --frequency-penalty --presence-penalty --seed`;
const currentCapabilities = parseCapabilities("llama.cpp version b9999", help);
describe("CLI builder",()=>{it("builds core llama-server flags",()=>{const args=buildServerArgs(TEST_CONFIG,currentCapabilities);expect(args).toContain("--model");expect(args).toContain("--ctx-size");expect(args).toContain("--fit-target");expect(args).toContain("--metrics");});it("quotes Windows paths in preview",()=>{expect(renderCommand(TEST_CONFIG,"powershell",currentCapabilities)).toContain('"C:\\TestModels\\test-model.gguf"')});it("tokenizes extra args with quoted values",()=>{expect(splitExtraArgs('--foo "hello world" --bar 1')).toEqual(["--foo","hello world","--bar","1"])});});

it("builds launch arguments from detected registry flags",()=>{const config={...TEST_CONFIG,device:"CUDA0",webUi:false,timeoutSeconds:120,httpThreads:8};const args=buildServerArgs(config,currentCapabilities);expect(args).toContain("--device");expect(args).toContain("CUDA0");expect(args).toContain("--no-ui");expect(args).toContain("--timeout");expect(args).toContain("--threads-http");});

it("disables fit for tensor split mode",()=>{
  const config={...TEST_CONFIG,splitMode:"tensor" as const,fit:true,tensorSplit:"1,1"};
  const args=buildServerArgs(config,currentCapabilities);
  const fitIndex=args.indexOf("--fit");
  expect(fitIndex).toBeGreaterThanOrEqual(0);
  expect(args[fitIndex+1]).toBe("off");
  expect(args).not.toContain("--fit-target");
  expect(args).not.toContain("--fit-ctx");
});

it("omits capability-gated flags for older llama.cpp builds",()=>{
  const args=buildServerArgs(TEST_CONFIG,{fit:false,fitTarget:false,fitContext:false,metrics:false,props:false,jinja:false,reasoning:false,reasoningFormat:false,cors:false,webUi:false,timeout:false,threadsHttp:false});
  expect(args).not.toContain("--fit");
  expect(args).not.toContain("--fit-target");
  expect(args).not.toContain("--metrics");
  expect(args).not.toContain("--ui");
  expect(args).not.toContain("--cors-origins");
});

it("does not emit unverified flags when capability detection is absent",()=>{
  expect(buildServerArgs(TEST_CONFIG)).toEqual([]);
});

it("does not confuse a similarly named flag with an exact capability",()=>{
  const capabilities=parseCapabilities("legacy","--ui-config --host --port");
  expect(capabilities.webUi).toBe(false);
  expect(buildServerArgs({...TEST_CONFIG,webUi:false},capabilities)).not.toContain("--no-ui");
});
