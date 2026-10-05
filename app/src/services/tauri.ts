import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, BenchmarkRequest, BenchmarkResult, BenchmarkSuiteDefinition, CommonLocationDiscovery, DetectionResult, LaunchProfile, ModelInfo, RouterRecoverySnapshot, ScanRoot, ServerEngine, StrataModelOption } from "../types/app";
import type { LaunchConfig, LlamaCapabilities } from "../types/config";
import type { LogLine, RuntimeSnapshot } from "../types/runtime";
import { buildServerArgs } from "../lib/cli";
import { buildRouterArgs, buildRouterPreset, type RouterPresetProfile } from "../lib/router";
import { parseCapabilities, parseDevices } from "../lib/capabilities";
import { DEFAULT_SETTINGS } from "../types/app";
import { MOCK_BENCHMARKS, MOCK_MODELS, MOCK_PROFILES, MOCK_RUNTIME } from "../mocks/runtime";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function startServer(config: LaunchConfig, capabilities?: Partial<LlamaCapabilities>) {
  if (!isTauri()) return { pid: 18424 };
  return invoke<{ pid: number }>("start_server", { request: { binaryPath: config.binaryPath, args: buildServerArgs(config, capabilities), endpoint: `http://${config.host}:${config.port}`, profileId: config.profileId, backend: "llama-server", apiKey: config.apiKey || null } });
}
export async function stopServer() { if (isTauri()) await invoke("stop_server"); }
export async function restartServer(config: LaunchConfig, capabilities?: Partial<LlamaCapabilities>) {
  if (!isTauri()) return { pid: 18424 };
  return invoke<{ pid: number }>("restart_server", { request: { binaryPath: config.binaryPath, args: buildServerArgs(config, capabilities), endpoint: `http://${config.host}:${config.port}`, profileId: config.profileId, backend: "llama-server", apiKey: config.apiKey || null } });
}
export async function getRouterPresetPath(): Promise<string> {
  if (!isTauri()) return "<Aplot Control LLM app data>\\router-presets.ini";
  return invoke<string>("router_preset_path");
}
export async function writeRouterPreset(profiles: RouterPresetProfile[], capabilities: Partial<LlamaCapabilities>) {
  const preset = buildRouterPreset(profiles, capabilities);
  const path = isTauri()
    ? await invoke<string>("write_router_preset", { preset: preset.content })
    : "<Aplot Control LLM app data>\\router-presets.ini";
  return { path, unsupportedParameters: preset.unsupportedParameters };
}
export async function refreshRouterProfiles(settings: AppSettings, profiles: LaunchProfile[], capabilities: Partial<LlamaCapabilities>) {
  const llamaProfiles = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  await validateLlamaModels(llamaProfiles.map(profile => profile.config.modelPath));
  await writeRouterPreset(llamaProfiles, capabilities);
  if (!isTauri()) return;
  const ids = await invoke<string[]>("reload_router_models", { endpoint: `http://${settings.routerHost}:${settings.routerPort}`, apiKey: settings.routerApiKey });
  const missing = llamaProfiles.filter(profile => !ids.includes(profile.name));
  if (missing.length) throw new Error(`Profiles missing from router: ${missing.map(profile => profile.name).join(", ")}`);
}
async function prepareRouterRequest(config: LaunchConfig, settings: AppSettings, profiles: LaunchProfile[], capabilities: Partial<LlamaCapabilities>) {
  const llamaProfiles = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  await validateLlamaModels(llamaProfiles.map(profile => profile.config.modelPath));
  const { path: presetPath, unsupportedParameters } = await writeRouterPreset(llamaProfiles, capabilities);
  const args = buildRouterArgs(settings, presetPath, capabilities);
  return {
    request: {
      binaryPath: config.binaryPath,
      args,
      endpoint: `http://${settings.routerHost}:${settings.routerPort}`,
      profileId: "router",
      apiKey: settings.routerApiKey,
      backend: "llama-server",
    },
    unsupportedParameters,
  };
}
export async function startRouter(config: LaunchConfig, settings: AppSettings, profiles: LaunchProfile[], capabilities: Partial<LlamaCapabilities>) {
  if (!isTauri()) return { pid: 18424, unsupportedParameters: [] as string[] };
  const { request, unsupportedParameters } = await prepareRouterRequest(config, settings, profiles, capabilities);
  const result = await invoke<{ pid: number }>("start_server", { request });
  return { ...result, unsupportedParameters };
}
export async function restartRouter(config: LaunchConfig, settings: AppSettings, profiles: LaunchProfile[], capabilities: Partial<LlamaCapabilities>) {
  if (!isTauri()) return { pid: 18424, unsupportedParameters: [] as string[] };
  const { request, unsupportedParameters } = await prepareRouterRequest(config, settings, profiles, capabilities);
  const result = await invoke<{ pid: number }>("restart_server", { request });
  return { ...result, unsupportedParameters };
}
export async function startStrataServer(settings: AppSettings) {
  if (!isTauri()) return { pid: 18424 };
  return invoke<{ pid: number }>("start_strata_server", { request: {
    rootPath: settings.strataRootPath,
    configPath: settings.strataConfigPath,
    host: settings.strataHost,
    port: settings.strataPort,
    apiKey: settings.strataApiKey,
  } });
}
export async function restartStrataServer(settings: AppSettings) {
  if (!isTauri()) return { pid: 18424 };
  return invoke<{ pid: number }>("restart_strata_server", { request: {
    rootPath: settings.strataRootPath,
    configPath: settings.strataConfigPath,
    host: settings.strataHost,
    port: settings.strataPort,
    apiKey: settings.strataApiKey,
  } });
}
export async function getRuntime(config: LaunchConfig, routerMode = false, engine: ServerEngine = "llama_cpp"): Promise<RuntimeSnapshot> {
  if (!isTauri()) return { ...MOCK_RUNTIME, endpoint: `http://${config.host}:${config.port}` };
  return invoke<RuntimeSnapshot>("runtime_snapshot", { endpoint: `http://${config.host}:${config.port}`, apiKey: config.apiKey || null, routerMode, fallbackModelId: routerMode ? config.profileName : null, engine });
}
export async function startQwfnServer(settings: AppSettings, restart = false) {
  if (!isTauri()) return { pid: 18425 };
  return invoke<{ pid: number }>(restart ? "restart_qwfn_server" : "start_qwfn_server", { settings: settings.qwfn });
}
export async function subscribeLogs(callback: (line: LogLine) => void): Promise<UnlistenFn> { if (!isTauri()) return () => undefined; return listen<LogLine>("llama://log", e => callback(e.payload)); }
export async function subscribeServerState(callback: (state: RuntimeSnapshot["state"]) => void): Promise<UnlistenFn> { if (!isTauri()) return () => undefined; return listen<RuntimeSnapshot["state"]>("llama://state", e => callback(e.payload)); }

export async function detectLlama(binaryPath: string): Promise<DetectionResult> {
  if (!isTauri()) {
    const helpOutput = `--model --alias --mmproj --lora --device --list-devices --gpu-layers --flash-attn --fit --fit-target --fit-ctx
--kv-offload --no-kv-offload --cache-type-k q8_0 q4_0 f16 --cache-type-v q8_0 q4_0 f16 --tensor-split --split-mode --main-gpu
--ctx-size --batch-size --ubatch-size --parallel --threads --threads-batch --cont-batching --no-cont-batching
--host --port --api-key --cors-origins --cors-methods --cors-headers --cors-credentials --no-cors-credentials
--ui --no-ui --timeout --threads-http --metrics --slots --no-slots --props --reasoning --reasoning-format
--jinja --no-jinja --temp --top-k --top-p --min-p --typical-p --repeat-penalty --repeat-last-n
--frequency-penalty --presence-penalty --seed --models-preset --models-max --models-autoload --no-models-autoload --models-dir --ui-config`;
    const versionOutput = "llama.cpp mock b9999";
    const devicesOutput = "Available devices:\n  CUDA0: NVIDIA GeForce RTX 5080 (16303 MiB, 15000 MiB free)";
    return { versionOutput, helpOutput, capabilities: parseCapabilities(versionOutput, helpOutput), devices: parseDevices(devicesOutput) };
  }
  const result = await invoke<{ versionOutput: string; helpOutput: string; devicesOutput: string }>("detect_llama", { binaryPath });
  return { versionOutput: result.versionOutput, helpOutput: result.helpOutput, capabilities: parseCapabilities(result.versionOutput, result.helpOutput), devices: parseDevices(result.devicesOutput) };
}

export async function listProfiles(): Promise<LaunchProfile[]> { return isTauri() ? invoke("list_profiles") : MOCK_PROFILES; }
export async function saveProfile(profile: LaunchProfile): Promise<LaunchProfile> { return isTauri() ? invoke("save_profile", { profile }) : profile; }
export async function deleteProfile(id: string): Promise<void> { if (isTauri()) await invoke("delete_profile", { id }); }
export async function exportProfile(id: string, path: string): Promise<void> { if (isTauri()) await invoke("export_profile", { id, path }); }
export async function importProfile(path: string): Promise<LaunchProfile> { return isTauri() ? invoke("import_profile", { path }) : MOCK_PROFILES[0]; }

export async function markProfileGood(id: string): Promise<void> { if (isTauri()) await invoke("mark_profile_good", { id }); }
export async function loadLastKnownGood(): Promise<LaunchProfile | null> { return isTauri() ? invoke("last_known_good_profile") : MOCK_PROFILES.find(p => p.lastKnownGood) ?? null; }
export async function markRouterGood(snapshot: RouterRecoverySnapshot): Promise<void> { if (isTauri()) await invoke("mark_router_good", { snapshot }); }
export async function loadLastKnownGoodRouter(): Promise<RouterRecoverySnapshot | null> { return isTauri() ? invoke("last_known_good_router") : null; }
export async function restoreLastKnownGoodRouter(): Promise<RouterRecoverySnapshot> {
  if (!isTauri()) throw new Error("Router recovery is only available in the desktop application.");
  return invoke("restore_last_known_good_router");
}

export async function scanModels(directories: string[]): Promise<ModelInfo[]> { return isTauri() ? invoke("scan_models", { directories }) : MOCK_MODELS; }
export async function listScanRoots(): Promise<ScanRoot[]> { return isTauri() ? invoke("list_scan_roots") : []; }
export async function scanLlamaServers(rootPath: string): Promise<string[]> { return isTauri() ? invoke("scan_llama_servers", { rootPath }) : []; }
export async function scanDiskModels(rootPath: string): Promise<ModelInfo[]> { return isTauri() ? invoke("scan_disk_models", { rootPath }) : MOCK_MODELS; }
export async function fetchOpenApiSpec(endpoint: string, apiKey: string, engine: ServerEngine): Promise<Record<string, unknown>> {
  if (!isTauri()) return { openapi: "3.0.0", info: { title: "Local API", version: "1.0.0" }, paths: {} };
  return invoke<Record<string, unknown>>("fetch_openapi_spec", { endpoint, apiKey, engine });
}
export async function discoverStrataModels(rootPath: string): Promise<StrataModelOption[]> { return isTauri() ? invoke("discover_strata_models", { rootValue: rootPath }) : []; }
export async function discoverCommonLocations(): Promise<CommonLocationDiscovery> { return isTauri() ? invoke("discover_common_locations") : { binaryCandidates: [], modelDirectories: [] }; }
export async function getSettings(): Promise<AppSettings> { return isTauri() ? invoke("get_settings") : DEFAULT_SETTINGS; }
export async function saveSettings(settings: AppSettings): Promise<AppSettings> { return isTauri() ? invoke("save_settings", { settings }) : settings; }
export async function listBenchmarks(): Promise<BenchmarkResult[]> { return isTauri() ? invoke("list_benchmarks") : MOCK_BENCHMARKS; }
const MOCK_BENCHMARK_SUITES: BenchmarkSuiteDefinition[] = [
  { id: "throughput-v1", version: 1, kind: "throughput", nameKey: "benchmark.suite.throughput.name", descriptionKey: "benchmark.suite.throughput.description", defaultPromptTokens: 2048, defaultGenerationTokens: 512, defaultRuns: 3, probeCount: 0, windowCount: 1, minimumAccuracy: null },
  { id: "context-recall-v1", version: 2, kind: "exact_recall", nameKey: "benchmark.suite.recall.name", descriptionKey: "benchmark.suite.recall.description", defaultPromptTokens: 16384, defaultGenerationTokens: 384, defaultRuns: 3, probeCount: 20, windowCount: 1, minimumAccuracy: 0.95, promptTargetRatio: 0.985 },
  { id: "context-stability-v1", version: 2, kind: "context_continuity", nameKey: "benchmark.suite.continuity.name", descriptionKey: "benchmark.suite.continuity.description", defaultPromptTokens: 65536, defaultGenerationTokens: 512, defaultRuns: 2, probeCount: 20, windowCount: 3, minimumAccuracy: 0.95, promptTargetRatio: 0.985, checkpointMaxTokens: 500 },
];
export async function listBenchmarkSuites(): Promise<BenchmarkSuiteDefinition[]> { return isTauri() ? invoke("list_benchmark_suites") : MOCK_BENCHMARK_SUITES; }
export async function runBenchmark(request: BenchmarkRequest, config: LaunchConfig, profileName = config.profileName): Promise<BenchmarkResult> {
  const enriched = { ...request, configSnapshot: request.configSnapshot ?? config };
  return isTauri() ? invoke("run_benchmark", { request: enriched, endpoint: `http://${config.host}:${config.port}`, profileName, apiKey: config.apiKey || null }) : MOCK_BENCHMARKS[0];
}
export async function runBenchmarkSuite(request: BenchmarkRequest, config: LaunchConfig, profileName = config.profileName): Promise<BenchmarkResult> {
  const enriched = { ...request, configSnapshot: request.configSnapshot ?? config };
  return isTauri() ? invoke("run_benchmark_suite", { request: enriched, endpoint: `http://${config.host}:${config.port}`, profileName, apiKey: config.apiKey || null }) : MOCK_BENCHMARKS[0];
}

export type DiskScanProgress = { root: string; visited: number; found: number; path: string };
export async function onDiskScanProgress(callback: (progress: DiskScanProgress) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<DiskScanProgress>("disk-scan-progress", event => callback(event.payload)) : () => {};
}

export async function validateLlamaModels(paths: string[]): Promise<void> { if (isTauri()) await invoke("validate_llama_models", { paths }); }
