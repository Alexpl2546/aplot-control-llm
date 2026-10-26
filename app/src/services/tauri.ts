import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, BenchmarkRequest, BenchmarkResult, BenchmarkSuiteDefinition, CommonLocationDiscovery, DetectionResult, LaunchProfile, ModelInfo, RouterRecoverySnapshot, ScanRoot, ServerEngine, StrataModelOption } from "../types/app";
import type { LaunchConfig, LlamaCapabilities } from "../types/config";
import type { LogLine, RuntimeSnapshot, RunInfo, RunLogEvent, RunStateEvent, StartRunRequest } from "../types/runtime";
import { BenchmarkJobCancelledError, type BenchmarkJobCallbacks, type BenchmarkJobProgressEvent, type JobInfo } from "../types/jobs";
import { buildServerArgs } from "../lib/cli";
import { buildRouterArgs, buildRouterPreset, routerModelId, routerModelIds, type RouterPresetProfile } from "../lib/router";
import { parseCapabilities, parseDevices } from "../lib/capabilities";
import { DEFAULT_SETTINGS } from "../types/app";
import { MOCK_BENCHMARKS, MOCK_MODELS, MOCK_PROFILES, MOCK_RUNTIME } from "../mocks/runtime";
import { demoUrlSettings } from "../lib/demoUrl";
import { deleteProfileV2, duplicateProfileV2, exportProfileFileV2, importProfileFileV2, listProfilesV2, loadLastKnownGoodV2, loadLastKnownGoodRouterV2, markProfileGoodV2, markRouterGoodV2, resolveProfileLaunchConfig, restoreLastKnownGoodProfileV2, restoreLastKnownGoodRouterV2, saveProfileV2 } from "../features/profiles/bridge";
import { isSupportedProfileEngine, restoreEngineOptions } from "../features/launches/profiles";

export type StrataEngineFamily = "qwen" | "deepseek";
export type StrataEngineUpdateStatus = "updated" | "upToDate" | "notInstalled" | "unavailable";
export interface StrataEngineUpdateResult {
  family: StrataEngineFamily;
  status: StrataEngineUpdateStatus;
  previousVersion?: string | null;
  currentVersion?: string | null;
  message: string;
}
export interface StrataEngineUpdateProgress {
  family: StrataEngineFamily;
  phase: string;
  percent?: number | null;
  message: string;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mockStartedAt = new Date(Date.now() - 1_697_000).toISOString();
const mockRuns: RunInfo[] = [
  { runId: "profile:example-balanced", name: "Example model — Balanced", engine: "llama_cpp", mode: "router", endpoint: "http://127.0.0.1:8080", modelId: "example-balanced", contextTokens: 65536, state: "ready", pid: 18424, generation: 1, managed: true, startedAt: mockStartedAt },
  { runId: "profile:example-long", name: "Example model — Long context", engine: "llama_cpp", mode: "router", endpoint: "http://127.0.0.1:8081", modelId: "example-long", contextTokens: 131072, state: "ready", pid: 18425, generation: 1, managed: true, startedAt: mockStartedAt },
];

function mockRuntime(run: RunInfo): RuntimeSnapshot {
  const longContext = run.contextTokens > 65536;
  const base = { ...MOCK_RUNTIME };
  return {
    ...base,
    processMemory: ['ready', 'busy', 'loading'].includes(run.state) ? { ramMiB: (longContext ? 6.3 : 18.1) * 1024, vramMiB: (longContext ? 3.8 : 8.2) * 1024, pids: run.pid ? [run.pid] : [], sampledAtMs: Date.now() } : null,
    state: run.state,
    endpoint: run.endpoint,
    backend: run.engine === "llama_cpp" ? "llama.cpp (CUDA)" : run.engine,
    modelName: run.name,
    pid: run.pid,
    processStartedAt: run.startedAt,
    lastError: run.lastError,
    contextTotal: run.contextTokens,
    generationTps: longContext ? 39.2 : 47.8,
    promptTps: longContext ? 105.6 : 121.4,
    gpu: { ...base.gpu, utilization: longContext ? 84 : 92, memoryUsedMiB: longContext ? 15120 : 14438 },
    slots: base.slots.map(slot => ({ ...slot, contextTotal: run.contextTokens, generationTps: longContext ? 39.2 : 48.1 })),
  };
}
function mockEndpointForRequest(request: StartRunRequest): string | undefined {
  const launch = request.launch;
  if (typeof launch.endpoint === "string") return launch.endpoint.replace(/\/$/, "");
  if (typeof launch.host === "string" && typeof launch.port === "number") return `http://${launch.host}:${launch.port}`;
  return undefined;
}

export interface RunLaunchInput {
  runId: string;
  config: LaunchConfig;
  settings: AppSettings;
  profiles: LaunchProfile[];
  capabilities: Partial<LlamaCapabilities>;
  /** Prepare a resource estimate without resolving secrets or touching files. */
  preview?: boolean;
}

// The resolver changes credential leaves only. Apply those changes to a temporary
// copy while keeping unsaved/trial parameters and explicit credential edits.
async function resolveLaunchSecrets(config: LaunchConfig, profiles: LaunchProfile[]): Promise<LaunchConfig> {
  const profile = profiles.find(item => item.id === config.profileId);
  if (!isTauri() || !profile?.v2 || !Object.keys(profile.v2.secretReferences ?? {}).length) return config;
  const resolved = await resolveProfileLaunchConfig(profile.id);
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const overlay = (draft: Record<string, unknown>, base: Record<string, unknown>, launch: Record<string, unknown>): Record<string, unknown> => {
    const result = structuredClone(draft);
    for (const [key, value] of Object.entries(launch)) {
      if (object(value)) {
        const current = object(result[key]) ? result[key] : {};
        const original = object(base[key]) ? base[key] : {};
        Object.defineProperty(result, key, { value: overlay(current, original, value), enumerable: true, writable: true, configurable: true });
      } else if (typeof value === "string" && value !== base[key] && (result[key] === undefined || result[key] === "" || result[key] === base[key])) {
        Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    return result;
  };
  return overlay(config as unknown as Record<string, unknown>, profile.config as unknown as Record<string, unknown>, resolved as unknown as Record<string, unknown>) as unknown as LaunchConfig;
}

export async function createRunStartRequest(input: RunLaunchInput): Promise<StartRunRequest> {
  const { runId, profiles, capabilities } = input;
  if (!isSupportedProfileEngine(input.config.engine ?? input.settings.serverEngine)) throw new Error(`Unsupported profile engine: ${input.config.engine}`);
  const config = input.preview ? input.config : await resolveLaunchSecrets(input.config, profiles);
  const settings = config.engine ? restoreEngineOptions(config, input.settings) : input.settings;
  if (!isSupportedProfileEngine(config.engine ?? settings.serverEngine)) throw new Error(`Unsupported profile engine: ${config.engine}`);
  const engine = config.engine ?? settings.serverEngine;
  if (!isSupportedProfileEngine(engine)) throw new Error(`Unsupported profile engine: ${engine}`);
  const activeSettings = engine === settings.serverEngine ? settings : restoreEngineOptions(config, settings);
  const mode = engine === "llama_cpp" ? activeSettings.serverMode : "single";
  let launch: Record<string, unknown>;
  let modelId: string;
  let contextTokens: number;
  if (engine === "llama_cpp") {
    if (mode === "router") {
      const prepared = await prepareRouterRequest(config, activeSettings, profiles, capabilities, runId, input.preview);
      launch = prepared.request;
      modelId = routerModelId({ id: config.profileId, name: config.profileName, config }, profiles);
    } else {
      const request = { binaryPath: config.binaryPath || activeSettings.binaryPath, args: buildServerArgs(config, capabilities), endpoint: `http://${config.host}:${config.port}`, profileId: config.profileId, backend: "llama-server", apiKey: config.apiKey || null };
      launch = request;
      modelId = config.modelPath;
    }
    contextTokens = config.ctxSize;
  } else if (engine === "strata") {
    launch = { rootPath: activeSettings.strataRootPath, configPath: activeSettings.strataConfigPath, host: activeSettings.strataHost, port: activeSettings.strataPort, apiKey: activeSettings.strataApiKey };
    modelId = activeSettings.strataConfigPath;
    contextTokens = Math.max(config.ctxSize, 0);
  } else throw new Error(`Unsupported profile engine: ${engine}`);
  return { runId, name: config.profileName, engine, mode, modelId, contextTokens, launch, autoPort: true };
}

export async function listRuns(): Promise<RunInfo[]> {
  if (isTauri()) return invoke<RunInfo[]>("list_runs");
  return mockRuns.map(run => ({ ...run }));
}
export async function startRun(request: StartRunRequest): Promise<RunInfo> {
  if (isTauri()) return invoke<RunInfo>("start_run", { request });
  const existing = mockRuns.find(run => run.runId === request.runId);
  if (existing && !["stopped", "crashed"].includes(existing.state)) return { ...existing };
  const run: RunInfo = { runId: request.runId, name: request.name, engine: request.engine, mode: request.mode, endpoint: mockEndpointForRequest(request) ?? existing?.endpoint ?? "http://127.0.0.1:8082", modelId: request.modelId, contextTokens: request.contextTokens, state: "ready", pid: existing?.pid ?? 18426 + mockRuns.length, generation: (existing?.generation ?? 0) + 1, managed: true, startedAt: new Date().toISOString() };
  if (existing) Object.assign(existing, run); else mockRuns.push(run);
  return { ...run };
}
export async function stopRun(runId: string): Promise<void> {
  if (isTauri()) return invoke<void>("stop_run", { runId });
  const run = mockRuns.find(item => item.runId === runId);
  if (run) { run.state = "stopped"; run.pid = undefined; }
}
export async function removeRun(runId: string): Promise<void> {
  if (isTauri()) return invoke<void>("remove_run", { runId });
  const index=mockRuns.findIndex(run=>run.runId===runId);
  if(index<0)return;
  if(!["stopped","crashed"].includes(mockRuns[index].state))throw new Error("Stop the server first");
  mockRuns.splice(index,1);
}
export async function restartRun(runId: string): Promise<RunInfo> {
  if (isTauri()) return invoke<RunInfo>("restart_run", { runId });
  const run = mockRuns.find(item => item.runId === runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  run.generation += 1; run.state = "ready"; run.pid = (run.pid ?? 18426) + 1; run.startedAt = new Date().toISOString();
  return { ...run };
}
export async function getRunRuntime(runId: string): Promise<RuntimeSnapshot> {
  if (isTauri()) return invoke<RuntimeSnapshot>("run_runtime", { runId });
  const run = mockRuns.find(item => item.runId === runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  return mockRuntime(run);
}
export async function getRunConnection(runId: string): Promise<Record<string, unknown>> {
  if (isTauri()) return invoke<Record<string, unknown>>("run_connection", { runId });
  const run = mockRuns.find(item => item.runId === runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  return { runId, engine: run.engine, modelId: run.modelId, baseUrl: `${run.endpoint.replace(/\/$/, "")}/v1`, apiKey: "", contextTokens: run.contextTokens, managed: run.managed, protocol: "openai-chat-completions" };
}
export async function stopAllRuns(): Promise<void> {
  if (isTauri()) return invoke<void>("stop_all_runs");
  for (const run of mockRuns) { run.state = "stopped"; run.pid = undefined; }
}

export async function subscribeRunLogs(callback: (event: RunLogEvent) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<RunLogEvent>("run://log", event => callback(event.payload)) : () => undefined;
}
export async function subscribeRunState(callback: (event: RunStateEvent) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<RunStateEvent>("run://state", event => callback(event.payload)) : () => undefined;
}

export async function startServer(config: LaunchConfig, capabilities?: Partial<LlamaCapabilities>) {
  if (!isTauri()) return { pid: 18424 };
  return invoke<{ pid: number }>("start_server", { request: { binaryPath: config.binaryPath, args: buildServerArgs(config, capabilities), endpoint: `http://${config.host}:${config.port}`, profileId: config.profileId, backend: "llama-server", apiKey: config.apiKey || null } });
}
export async function stopServer() { if (isTauri()) await invoke("stop_server"); }
export async function restartServer(config: LaunchConfig, capabilities?: Partial<LlamaCapabilities>) {
  if (!isTauri()) return { pid: 18424 };
  return invoke<{ pid: number }>("restart_server", { request: { binaryPath: config.binaryPath, args: buildServerArgs(config, capabilities), endpoint: `http://${config.host}:${config.port}`, profileId: config.profileId, backend: "llama-server", apiKey: config.apiKey || null } });
}
export async function getRouterPresetPath(runId?: string): Promise<string> {
  if (!isTauri()) {
    const runDirectory = runId ? `\\routers\\${runId.replace(/[^A-Za-z0-9_-]/g, "_")}\\preset.ini` : "\\router-presets.ini";
    return `<Aplot Control LLM app data>${runDirectory}`;
  }
  return runId ? invoke<string>("router_preset_path", { runId }) : invoke<string>("router_preset_path");
}
export async function writeRouterPreset(profiles: RouterPresetProfile[], capabilities: Partial<LlamaCapabilities>, runId?: string) {
  const preset = buildRouterPreset(profiles, capabilities);
  const path = isTauri()
    ? await invoke<string>("write_router_preset", runId ? { preset: preset.content, runId } : { preset: preset.content })
    : await getRouterPresetPath(runId);
  return { path, unsupportedParameters: preset.unsupportedParameters };
}
export async function refreshRouterProfiles(settings: AppSettings, profiles: LaunchProfile[], capabilities: Partial<LlamaCapabilities>, target?: { runId?: string; profileId?: string }) {
  const llamaProfiles = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  await validateLlamaModels(llamaProfiles.map(profile => profile.config.modelPath));
  await writeRouterPreset(llamaProfiles, capabilities, target?.runId);
  if (!isTauri()) return;
  const selected = profiles.find(profile => profile.id === target?.profileId);
  const apiKey = selected ? restoreEngineOptions(await resolveLaunchSecrets(selected.config, profiles), settings).routerApiKey : settings.routerApiKey;
  const ids = await invoke<string[]>("reload_router_models", { endpoint: `http://${settings.routerHost}:${settings.routerPort}`, apiKey });
  const modelIds = routerModelIds(llamaProfiles);
  const missing = llamaProfiles.filter(profile => !ids.includes(modelIds.get(profile.id)!));
  if (missing.length) throw new Error(`Profiles missing from router: ${missing.map(profile => profile.name).join(", ")}`);
}
async function prepareRouterRequest(config: LaunchConfig, settings: AppSettings, profiles: LaunchProfile[], capabilities: Partial<LlamaCapabilities>, runId?: string, preview = false) {
  const llamaProfiles = profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
  if (!preview) await validateLlamaModels(llamaProfiles.map(profile => profile.config.modelPath));
  const { path: presetPath, unsupportedParameters } = preview
    ? { path: "<router-preset>", unsupportedParameters: buildRouterPreset(llamaProfiles, capabilities).unsupportedParameters }
    : await writeRouterPreset(llamaProfiles, capabilities, runId);
  const args = buildRouterArgs(settings, presetPath, capabilities, config.webUi);
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

export async function listProfiles(): Promise<LaunchProfile[]> { return isTauri() ? listProfilesV2() : MOCK_PROFILES; }
export async function saveProfile(profile: LaunchProfile): Promise<LaunchProfile> { return isTauri() ? saveProfileV2(profile) : profile; }
export async function duplicateProfileSnapshot(profile: LaunchProfile, newId: string, name: string): Promise<LaunchProfile> {
  if (!isTauri()) return { ...structuredClone(profile), id: newId, name, revision: undefined };
  if (profile.revision === undefined) throw new Error("A profile revision is required for duplicate.");
  return duplicateProfileV2(profile.id, newId, name, profile.revision);
}
export async function deleteProfile(id: string, expectedRevision?: number): Promise<void> {
  if (!isTauri()) return;
  if (expectedRevision === undefined) throw new Error("A profile revision is required for delete.");
  await deleteProfileV2(id, expectedRevision);
}
export async function exportProfile(id: string, path: string): Promise<void> { if (isTauri()) await exportProfileFileV2(id, path); }
export async function importProfile(path: string): Promise<LaunchProfile> { return isTauri() ? importProfileFileV2(path) : MOCK_PROFILES[0]; }

export async function markProfileGood(id: string, expectedRevision?: number): Promise<void> {
  if (isTauri()) await markProfileGoodV2(id, expectedRevision);
}
export async function loadLastKnownGood(): Promise<LaunchProfile | null> { return isTauri() ? loadLastKnownGoodV2() : MOCK_PROFILES.find(p => p.lastKnownGood) ?? null; }
export async function restoreLastKnownGoodProfile(): Promise<LaunchProfile> {
  if (!isTauri()) { const profile = await loadLastKnownGood(); if (profile) return profile; throw new Error("No known-good profile."); }
  return restoreLastKnownGoodProfileV2();
}
export async function markRouterGood(snapshot: RouterRecoverySnapshot): Promise<void> { if (isTauri()) await markRouterGoodV2(snapshot); }
export async function loadLastKnownGoodRouter(): Promise<RouterRecoverySnapshot | null> { return isTauri() ? loadLastKnownGoodRouterV2() : null; }
export async function restoreLastKnownGoodRouter(): Promise<RouterRecoverySnapshot> {
  if (!isTauri()) throw new Error("Router recovery is only available in the desktop application.");
  return restoreLastKnownGoodRouterV2();
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
export async function updateStrataEngine(rootPath: string, family: StrataEngineFamily): Promise<StrataEngineUpdateResult> {
  if (!isTauri()) throw new Error("Strata engine updates are only available in the desktop application.");
  return invoke<StrataEngineUpdateResult>("update_strata_engine", { rootPath, family });
}
export async function subscribeStrataEngineUpdate(callback: (progress: StrataEngineUpdateProgress) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<StrataEngineUpdateProgress>("strata://engine-update", event => callback(event.payload)) : () => {};
}
export async function discoverCommonLocations(): Promise<CommonLocationDiscovery> { return isTauri() ? invoke("discover_common_locations") : { binaryCandidates: [], modelDirectories: [] }; }
export async function getSettings(): Promise<AppSettings> { return isTauri() ? invoke("get_settings") : { ...DEFAULT_SETTINGS, binaryPath: "C:\\Aplot-Demo\\llama-server.exe", ...demoUrlSettings() }; }
export async function saveSettings(settings: AppSettings): Promise<AppSettings> { return isTauri() ? invoke("save_settings", { settings }) : settings; }
export async function listBenchmarks(): Promise<BenchmarkResult[]> { return isTauri() ? invoke("list_benchmarks") : MOCK_BENCHMARKS; }
export async function startBenchmarkJob(runId: string, request: BenchmarkRequest): Promise<JobInfo> {
  if (!isTauri()) throw new Error("Benchmark jobs are only available in the desktop application.");
  return invoke<JobInfo>("start_benchmark_job", { runId, request });
}
export async function cancelJob(jobId: string): Promise<void> {
  if (isTauri()) await invoke("cancel_job", { jobId });
}
export async function listJobs(): Promise<JobInfo[]> {
  return isTauri() ? invoke<JobInfo[]>("list_jobs") : [];
}
export async function subscribeJobState(callback: (job: JobInfo) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<JobInfo>("job://state", event => callback(event.payload)) : () => {};
}
export async function subscribeJobProgress(callback: (event: BenchmarkJobProgressEvent) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<BenchmarkJobProgressEvent>("job://progress", event => callback(event.payload)) : () => {};
}

const waitForJobUpdate = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const isTerminalJob = (job: JobInfo) => ["completed", "cancelled", "failed", "interrupted"].includes(job.status);

/** Starts a job and resolves it to the persisted benchmark result. */
export async function runBenchmarkJob(runId: string, request: BenchmarkRequest, callbacks: BenchmarkJobCallbacks = {}): Promise<BenchmarkResult> {
  if (!isTauri()) {
    const benchmark = MOCK_BENCHMARKS[0];
    const job: JobInfo = { jobId: `mock:${benchmark.id}`, runId, generation: 1, engine: "llama_cpp", status: "completed", createdAt: benchmark.createdAt, updatedAt: benchmark.createdAt, benchmarkId: benchmark.id, evidence: {} };
    callbacks.onStarted?.(job);
    callbacks.onProgress?.({ jobId: job.jobId, runId, generation: job.generation, progress: { phase: "completed" } });
    callbacks.onState?.(job);
    return benchmark;
  }

  let offState: UnlistenFn | undefined;
  let offProgress: UnlistenFn | undefined;
  let jobId: string | undefined;
  const pendingStates: JobInfo[] = [];
  const pendingProgress: BenchmarkJobProgressEvent[] = [];
  let lastState = "";
  const deliverState = (job: JobInfo) => {
    if (job.jobId !== jobId) return;
    const signature = JSON.stringify(job);
    if (signature !== lastState) {
      lastState = signature;
      callbacks.onState?.(job);
    }
  };
  const deliverProgress = (event: BenchmarkJobProgressEvent) => {
    if (event.jobId === jobId) callbacks.onProgress?.(event);
  };

  try {
    offState = await subscribeJobState(job => {
      if (!jobId) pendingStates.push(job);
      else deliverState(job);
    });
    offProgress = await subscribeJobProgress(event => {
      if (!jobId) pendingProgress.push(event);
      else deliverProgress(event);
    });

    const queued = await startBenchmarkJob(runId, request);
    jobId = queued.jobId;
    callbacks.onStarted?.(queued);
    deliverState(queued);
    for (const job of pendingStates) deliverState(job);
    for (const event of pendingProgress) deliverProgress(event);

    while (true) {
      const job = (await listJobs()).find(candidate => candidate.jobId === jobId);
      if (job) {
        deliverState(job);
        if (isTerminalJob(job)) {
          if (job.status === "cancelled") throw new BenchmarkJobCancelledError();
          if (job.status !== "completed") throw new Error(job.error || `Benchmark job ${job.status}.`);
          if (!job.benchmarkId) throw new Error("Benchmark job completed without a result ID.");
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const result = (await listBenchmarks()).find(candidate => candidate.id === job.benchmarkId);
            if (result) return result;
            if (attempt < 3) await waitForJobUpdate(250);
          }
          throw new Error("The completed benchmark result could not be loaded.");
        }
      }
      await waitForJobUpdate(350);
    }
  } finally {
    offProgress?.();
    offState?.();
  }
}
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

export interface EngineInstallation { id: ServerEngine; path: string; version: string }
export async function availableEngines(settings: AppSettings): Promise<EngineInstallation[]> {
  if (isTauri()) return invoke("available_engines", { settings });
  return (["llama_cpp", "strata"] as const).map(id => ({ id, path: "demo", version: "demo" }));
}
