import { DEFAULT_CAPABILITIES, type KvCacheType, type LlamaCapabilities } from "../types/config";
import type { LlamaDevice } from "../types/app";

const KNOWN_KV: KvCacheType[] = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];
function parseArgs(help: string): string[] {
  const found = new Set<string>();
  for (const match of help.matchAll(/(?:^|\s)(--[a-z0-9][a-z0-9-]*)/gim)) found.add(match[1]);
  return [...found].sort();
}

export function parseCapabilities(versionOutput: string, helpOutput: string): LlamaCapabilities {
  const help = helpOutput || "";
  const argumentsFound = parseArgs(help);
  const has = (...flags: string[]) => flags.some(flag => argumentsFound.includes(flag));
  const versionLine = versionOutput.split(/\r?\n/).find(Boolean)?.trim() || "unknown";
  const versionMatch = versionOutput.match(/(?:version|build)\s*[:=]?\s*([^\s]+)/i);
  const commitMatch = versionOutput.match(/(?:commit|hash)\s*[:=]?\s*([0-9a-f]{7,40})/i);
  const buildMatch = versionOutput.match(/build\s*(?:number)?\s*[:=]?\s*([^\s]+)/i);
  const kvTypes = has("--cache-type-k", "--cache-type-v") ? KNOWN_KV.filter(type => help.includes(type)) : [];
  return {
    ...DEFAULT_CAPABILITIES,
    version: versionMatch?.[1] || versionLine,
    build: buildMatch?.[1],
    commit: commitMatch?.[1],
    rawVersion: versionOutput,
    rawHelp: helpOutput,
    device: has("--device"),
    gpuLayers: has("--gpu-layers", "--n-gpu-layers"),
    flashAttention: has("--flash-attn"),
    kvCacheTypes: kvTypes,
    fit: has("--fit"),
    fitTarget: has("--fit-target"),
    fitContext: has("--fit-ctx"),
    metrics: has("--metrics"),
    slots: has("--slots", "--no-slots"),
    tensorSplit: has("--tensor-split"),
    splitMode: has("--split-mode"),
    kvOffload: has("--kv-offload", "--no-kv-offload"),
    modelsRouter: has("--models-preset") && has("--models-max") && has("--models-autoload", "--no-models-autoload"),
    props: has("--props"),
    reasoning: has("--reasoning"),
    reasoningFormat: has("--reasoning-format"),
    jinja: has("--jinja", "--no-jinja"),
    apiKey: has("--api-key"),
    cors: has("--cors-origins", "--cors-methods", "--cors-headers", "--cors-credentials", "--no-cors-credentials"),
    uiConfig: has("--ui-config"),
    webUi: has("--webui", "--ui", "--no-ui"),
    timeout: has("--timeout"),
    threadsHttp: has("--threads-http"),
    lora: has("--lora"),
    mmproj: has("--mmproj"),
    rawArguments: argumentsFound,
  };
}


export function parseDevices(output: string): LlamaDevice[] {
  const devices: LlamaDevice[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([A-Za-z]+\d+|RPC\d+):\s+(.+?)(?:\s+\((\d+)\s+MiB(?:,\s*(\d+)\s+MiB free)?\))?$/i);
    if (!match) continue;
    devices.push({ id: match[1], name: match[2].trim(), memoryMiB: match[3] ? Number(match[3]) : undefined, freeMiB: match[4] ? Number(match[4]) : undefined, raw: line });
  }
  return devices;
}
