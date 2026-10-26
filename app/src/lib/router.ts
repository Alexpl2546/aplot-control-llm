import type { AppSettings, LaunchProfile } from "../types/app";
import { DEFAULT_CONFIG, type LaunchConfig, type LlamaCapabilities } from "../types/config";
import { PARAMETER_REGISTRY, isParameterAvailable } from "./parameters";
import { splitExtraArgs } from "./cli";

export type RouterSettings = Pick<AppSettings,
  "routerHost" | "routerPort" | "routerMaxLoadedModels" | "routerAutoload" | "routerApiKey"
>;

export interface RouterPresetProfile {
  id?: string;
  name: string;
  config: LaunchConfig;
}

export interface RouterPresetResult {
  content: string;
  unsupportedParameters: string[];
}

/** Stable route identities without renaming or dropping saved profiles. */
export function routerModelIds(profiles: readonly RouterPresetProfile[]): Map<string, string> {
  const routes = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  const counts = new Map<string, number>();
  const identity = (profile: RouterPresetProfile) => profile.id ?? profile.config.profileId;
  const folded = (name: string) => name.toLocaleLowerCase("en-US");
  const ids = new Set<string>();
  for (const profile of routes) {
    const name = profile.name.trim();
    const id = identity(profile);
    if (!name || /[\r\n\[\]]/.test(name)) throw new Error(`Profile name cannot be used as a router model ID: ${profile.name || "(empty)"}`);
    if (!id || ids.has(id)) throw new Error(`Router profile identities must be unique: ${id}`);
    ids.add(id);
    counts.set(folded(name), (counts.get(folded(name)) ?? 0) + 1);
  }
  const used = new Set(routes.filter(p => counts.get(folded(p.name.trim())) === 1).map(p => folded(p.name.trim())));
  const result = new Map<string, string>();
  for (const profile of [...routes].sort((a, b) => identity(a).localeCompare(identity(b), "en-US"))) {
    const id = identity(profile);
    const name = profile.name.trim();
    if (counts.get(folded(name)) === 1) { result.set(id, name); continue; }
    const base = `${name}--${encodeURIComponent(id)}`;
    let route = base;
    let suffix = 2;
    while (used.has(folded(route))) route = `${base}-${suffix++}`;
    used.add(folded(route));
    result.set(id, route);
  }
  return result;
}

export function routerModelId(profile: RouterPresetProfile, profiles: readonly RouterPresetProfile[]): string {
  const id = profile.id ?? profile.config.profileId;
  const route = routerModelIds(profiles).get(id);
  if (!route) throw new Error(`Profile is missing from router: ${id}`);
  return route;
}

const GLOBAL_PRESET_KEYS = new Set([
  "log-colors", "log-verbosity", "metrics", "offline", "load-on-startup", "stop-timeout",
]);

function presetValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (/[\r\n]/.test(value)) throw new Error("Router preset values cannot contain line breaks.");
    return value.trim();
  }
  return String(value);
}

function addLines(lines: string[], key: string, value: unknown) {
  const normalizedKey = key.toLowerCase().replace(/^--/, "").replaceAll("_", "-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalizedKey)) {
    throw new Error(`Unsupported router preset option: ${key}`);
  }
  const normalizedValue = presetValue(value);
  lines.push(`${normalizedKey} = ${normalizedValue}`);
}

function appendExtraArguments(lines: string[], input: string) {
  const args = splitExtraArgs(input);
  const managedFlags = new Set(PARAMETER_REGISTRY.flatMap(parameter => [parameter.cli, ...(parameter.cliAliases ?? [])]).filter(Boolean));
  const managedNegativeFlags = new Set(PARAMETER_REGISTRY.flatMap(parameter => [parameter.negativeCli, ...(parameter.negativeCliAliases ?? [])]).filter(Boolean));

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-")) throw new Error(`Unexpected value in profile extra arguments: ${token}`);

    const equals = token.indexOf("=");
    const rawFlag = equals > 0 ? token.slice(0, equals) : token;
    const flag = rawFlag.replace(/^-+/, "").replaceAll("_", "-").toLowerCase();
    const valueInToken = equals > 0 ? token.slice(equals + 1) : undefined;
    const next = args[index + 1];

    if (managedFlags.has(rawFlag) || managedNegativeFlags.has(rawFlag)) {
      if (valueInToken === undefined && next && !next.startsWith("--")) index += 1;
      continue;
    }
    if (GLOBAL_PRESET_KEYS.has(flag)) {
      if (valueInToken === undefined && next && !next.startsWith("--")) index += 1;
      continue;
    }

    let value = valueInToken;
    if (value === undefined && next && !next.startsWith("--")) {
      value = next;
      index += 1;
    }
    if (value === undefined) value = "true";
    addLines(lines, flag, value);
  }
}

export function buildRouterPreset(
  profiles: readonly RouterPresetProfile[],
  capabilities: Partial<LlamaCapabilities>,
): RouterPresetResult {
  if (profiles.length === 0) throw new Error("The router needs at least one saved profile.");

  const modelIds = routerModelIds(profiles);
  const unsupportedParameters = new Set<string>();
  // llama.cpp rejects OpenAI requests containing `tools` unless the selected
  // profile was started with --jinja. Router mode serves OpenAI-compatible
  // clients, so enable it for every route when this exact flag is available,
  // even if an older imported profile stored jinja=false.
  const jinjaSupported = capabilities.rawHelp !== undefined
    ? capabilities.rawArguments?.includes("--jinja") === true
    : capabilities.jinja === true;
  const lines = [
    "version = 1",
    "",
    "; Profiles are generated from the saved Aplot Control LLM profiles.",
    "[*]",
    "log-verbosity = 4",
    "log-colors = off",
    "offline = true",
    "stop-timeout = 15",
    "load-on-startup = false",
  ];
  if (capabilities.rawHelp === undefined || capabilities.metrics === true) lines.push("metrics = true");

  for (const profile of profiles) {
    const name = modelIds.get(profile.id ?? profile.config.profileId);
    if (!name) throw new Error(`Unsupported router profile: ${profile.name}`);
    if (!profile.config.modelPath.trim()) throw new Error(`Profile "${name}" has no GGUF model file.`);

    lines.push("", `[${name}]`);
    for (const parameter of PARAMETER_REGISTRY) {
      if (!parameter.routerKey) continue;
      if (parameter.enabled && !parameter.enabled(profile.config) && !parameter.serializeValue) continue;

      if (parameter.key === "jinja" && !jinjaSupported) {
        unsupportedParameters.add(parameter.labelKey);
        continue;
      }

      const available = capabilities.rawHelp !== undefined
        ? isParameterAvailable(parameter, capabilities as LlamaCapabilities)
        : !parameter.capability || capabilities[parameter.capability] === true;
      const value = parameter.key === "jinja" ? true : parameter.serializeValue
        ? parameter.serializeValue(profile.config)
        : profile.config[parameter.key] as unknown;
      if (!available) {
        const defaultValue = DEFAULT_CONFIG[parameter.key] as unknown;
        if (JSON.stringify(value) !== JSON.stringify(defaultValue)) unsupportedParameters.add(parameter.labelKey);
        continue;
      }
      if (value === undefined || value === null || (typeof value === "string" && !value.trim())) continue;
      if (Array.isArray(value)) {
        for (const item of value) if (String(item).trim()) addLines(lines, parameter.routerKey, item);
      } else if (parameter.valueMode === "on-off") {
        addLines(lines, parameter.routerKey, value ? "on" : "off");
      } else {
        addLines(lines, parameter.routerKey, value);
      }
    }
    appendExtraArguments(lines, profile.config.extraArgs);
  }

  return { content: `${lines.join("\n")}\n`, unsupportedParameters: [...unsupportedParameters] };
}

function supports(capabilities: Partial<LlamaCapabilities>, flag: string) {
  return capabilities.rawHelp === undefined || capabilities.rawArguments?.includes(flag) === true;
}

export function buildRouterArgs(
  settings: RouterSettings,
  presetPath: string,
  capabilities: Partial<LlamaCapabilities>,
  webUi = true,
): string[] {
  if (capabilities.rawHelp !== undefined && capabilities.modelsRouter !== true) {
    throw new Error("The selected llama-server build does not support router presets.");
  }
  if (!settings.routerHost.trim()) throw new Error("Router host is required.");
  if (!Number.isInteger(settings.routerPort) || settings.routerPort < 1 || settings.routerPort > 65535) {
    throw new Error("Router port must be between 1 and 65535.");
  }
  if (!Number.isInteger(settings.routerMaxLoadedModels) || settings.routerMaxLoadedModels < 1 || settings.routerMaxLoadedModels > 64) {
    throw new Error("Maximum loaded models must be between 1 and 64.");
  }
  if (!presetPath.trim()) throw new Error("The router preset path is unavailable.");

  const args = ["--models-preset", presetPath, "--models-max", String(settings.routerMaxLoadedModels)];
  if (supports(capabilities, "--models-autoload")) args.push("--models-autoload");
  if (supports(capabilities, "--host")) args.push("--host", settings.routerHost.trim());
  if (supports(capabilities, "--port")) args.push("--port", String(settings.routerPort));
  const uiFlags = webUi ? ["--ui", "--webui"] : ["--no-ui", "--no-webui"];
  const uiFlag = uiFlags.find(flag => supports(capabilities, flag));
  if (uiFlag) args.push(uiFlag);
  if (supports(capabilities, "--metrics")) args.push("--metrics");
  if (supports(capabilities, "--log-verbosity")) args.push("--log-verbosity", "4");
  if (supports(capabilities, "--log-colors")) args.push("--log-colors", "off");
  return args;
}

function quote(value: string) {
  return /[\\\s"'&|<>^]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function renderRouterCommand(
  config: LaunchConfig,
  profiles: readonly RouterPresetProfile[],
  settings: RouterSettings,
  presetPath: string,
  shell: "powershell" | "cmd" | "bash",
  capabilities: Partial<LlamaCapabilities>,
): string {
  const args = buildRouterArgs(settings, presetPath, capabilities, config.webUi);
  const continuation = shell === "powershell" ? " `" : shell === "cmd" ? " ^" : " \\";
  const tokens = [quote(config.binaryPath || "llama-server.exe"), ...args.map(quote)];
  const count = profiles.length;
  const comment = shell === "powershell" ? `# ${count} profile routes; set LLAMA_API_KEY before manual launch if needed` :
    shell === "cmd" ? `REM ${count} profile routes; set LLAMA_API_KEY before manual launch if needed` :
      `# ${count} profile routes; set LLAMA_API_KEY before manual launch if needed`;
  return `${comment}\n${tokens.map((token, index) => index === 0 ? token + continuation : `  ${token}${index === tokens.length - 1 ? "" : continuation}`).join("\n")}`;
}
