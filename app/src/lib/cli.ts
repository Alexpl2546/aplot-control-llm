import type { LaunchConfig, LlamaCapabilities } from "../types/config";
import { PARAMETER_REGISTRY, selectedCliFlag } from "./parameters";
export type ShellKind = "powershell" | "cmd" | "bash";

function quote(value: string) { return /[\\\s"'&|<>^]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value; }

export function buildServerArgs(config: LaunchConfig, caps?: Partial<LlamaCapabilities>): string[] {
  const a: string[] = [];
  for (const parameter of PARAMETER_REGISTRY) {
    if (!parameter.cli) continue;
    if (parameter.enabled && !parameter.enabled(config) && !parameter.serializeValue) continue;
    const flag = selectedCliFlag(parameter, config, caps);
    if (!flag) continue;
    const value = parameter.serializeValue ? parameter.serializeValue(config) : config[parameter.key] as unknown;

    if (parameter.valueMode === "on-off") {
      a.push(flag, value ? "on" : "off");
    } else if (typeof value === "boolean") {
      if (value) a.push(flag);
      else if (parameter.negativeCli && flag === parameter.negativeCli) a.push(flag);
    } else if (Array.isArray(value)) {
      for (const item of value) if (String(item).trim()) a.push(flag, String(item));
    } else if (value !== undefined && value !== null && String(value).trim() !== "") {
      const argument = typeof value === "string" && parameter.kind !== "path" ? value.trim() : String(value);
      a.push(flag, argument);
    }
  }
  const extra = splitExtraArgs(config.extraArgs);
  a.push(...extra);
  return a;
}

export function splitExtraArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g;
  for (const m of input.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3]).replace(/\\(["'])/g, "$1"));
  return out;
}

export function renderCommand(config: LaunchConfig, shell: ShellKind, caps?: Partial<LlamaCapabilities>): string {
  const args = buildServerArgs(config, caps);
  const binary = quote(config.binaryPath || "llama-server.exe");
  const tokens = [binary, ...args.map(quote)];
  const continuation = shell === "powershell" ? " `" : shell === "cmd" ? " ^" : " \\";
  if (tokens.length < 2) return binary;
  return tokens.map((token, i) => i === 0 ? token + continuation : `  ${token}${i === tokens.length - 1 ? "" : continuation}`).join("\n");
}
