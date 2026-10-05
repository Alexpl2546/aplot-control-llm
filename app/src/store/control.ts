import { create } from "zustand";
import i18n from "../lib/i18n";
import { appendRuntimeHistory } from "../lib/history";
import { shouldCommitReadyLaunch } from "../lib/lastKnownGood";
import { withConfiguredBinary } from "../lib/profileConfig";
import { strataRuntimeConfig } from "../lib/serverContext";
import { validateConfig } from "../lib/validation";
import { DEFAULT_SETTINGS, type AppSettings, type AppView, type BenchmarkRequest, type BenchmarkResult, type BenchmarkProfileSelection, type BenchmarkProfileGoal, type BenchmarkSuiteDefinition, type BenchmarkTuningProgress, type LaunchProfile, type ModelInfo, type AppNotice, type LlamaDevice, type RouterRecoverySnapshot, type RouterSnapshotSettings, type ServerEngine, type ServerMode } from "../types/app";
import { DEFAULT_CAPABILITIES, DEFAULT_CONFIG, type LaunchConfig, type LlamaCapabilities } from "../types/config";
import type { LogLine, RuntimeHistoryPoint, RuntimeSnapshot, ServerState } from "../types/runtime";
import { MOCK_LOGS, MOCK_RUNTIME } from "../mocks/runtime";
import * as bridge from "../services/tauri";
import { syncWindowsAutostart } from "../services/desktop";
import { ollamaAction, ollamaLibrary, ollamaCachedLibrary, ollamaRuntime, startOllama, benchmarkOllama, type OllamaModel } from "../services/ollama";
import { buildEngineModels, supportsEngine, type EngineModel, ENGINE_NAMES } from "../lib/engineModels";
import { modelLaunchMetadata } from "../lib/models";
import type { StrataModelOption } from "../types/app";
import { buildBenchmarkCandidates, buildProfileSearchCandidates, rankProfileResults, MINIMUM_AGENT_CONTEXT, DEFAULT_SEARCH_CONTEXT } from "../lib/benchmarkOptimizer";

let runtimeRefreshInFlight = false;
let routerSyncQueue: Promise<void> = Promise.resolve();

interface ControlState {
  benchmarkProgress?: import("../types/app").BenchmarkProgress;
  benchmarkEvents: (import("../types/app").BenchmarkProgress & { timestamp: number })[];
  activeView: AppView;
  config: LaunchConfig;
  savedConfig: LaunchConfig;
  capabilities: LlamaCapabilities;
  runtime: RuntimeSnapshot;
  runningConfig?: LaunchConfig;
  runningMode?: ServerMode;
  runningEngine?: ServerEngine;
  runningRouterSettings?: RouterSnapshotSettings;
  runningOllamaSettings?: Pick<AppSettings, "ollamaEndpoint" | "ollamaModel" | "ollamaContext">;
  launchPid?: number;
  launchAttempt: number;
  readyAttempt: number;
  history: RuntimeHistoryPoint[];
  logs: LogLine[];
  profiles: LaunchProfile[];
  knownGoodProfile?: LaunchProfile;
  knownGoodRouter?: RouterRecoverySnapshot;
  models: ModelInfo[];
  libraryModels: EngineModel[];
  ollamaModels: OllamaModel[];
  strataModels: StrataModelOption[];
  libraryErrors: string[];
  ollamaConnectionError?: string;
  syncRouterProfiles: () => Promise<void>;
  selectLibraryModel: (id: string, engine: ServerEngine) => Promise<boolean>;
  devices: LlamaDevice[];
  benchmarks: BenchmarkResult[];
  benchmarkSuites: BenchmarkSuiteDefinition[];
  optimizerProgress?: BenchmarkTuningProgress;
  optimizerRecommendation?: BenchmarkResult;
  optimizerProfiles: BenchmarkProfileSelection[];
  optimizerCancelRequested: boolean;
  optimizerRunning: boolean;
  notices: AppNotice[];
  settings: AppSettings;
  dirty: boolean;
  initialized: boolean;
  busy: boolean;
  error?: string;
  logFilter: "ALL" | LogLine["level"];
  logSearch: string;
  setView: (view: AppView) => void;
  updateConfig: <K extends keyof LaunchConfig>(key: K, value: LaunchConfig[K]) => void;
  replaceConfig: (config: LaunchConfig, saved?: boolean) => void;
  saveCurrentProfile: () => Promise<void>;
  duplicateProfile: (name?: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  importProfile: (path: string) => Promise<void>;
  exportProfile: (id: string, path: string) => Promise<void>;
  selectProfile: (id: string) => Promise<void>;
  saveConfigLocal: () => void;
  setServerState: (state: ServerState) => void;
  start: (profileId?: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: (profileId?: string) => Promise<void>;
  rollback: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  appendLog: (line: LogLine) => void;
  clearLogs: () => void;
  setLogFilter: (filter: ControlState["logFilter"]) => void;
  setLogSearch: (value: string) => void;
  detectBinary: (binaryPath?: string) => Promise<void>;
  rescanModels: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  runBenchmark: (request: BenchmarkRequest) => Promise<void>;
  runAutoTune: (request: BenchmarkRequest) => Promise<void>;
  cancelAutoTune: () => void;
  applyOptimizerRecommendation: () => void;
  dismissNotice: (id: string) => void;
  notify: (kind: AppNotice["kind"], message: string) => void;
  clearError: () => void;
  initialize: () => Promise<void>;
}

const now = () => new Date().toISOString();
const delay = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
function generateRouterApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `aplot_${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function waitForServerReady(config: LaunchConfig, routerMode: boolean) {
  let last = await bridge.getRuntime(config, routerMode);
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (["ready", "busy", "crashed"].includes(last.state) || (last.state === "stopped" && attempt >= 4)) return last;
    await delay(2000);
    last = await bridge.getRuntime(config, routerMode);
  }
  return last;
}
const INITIAL_RUNTIME: RuntimeSnapshot = bridge.isTauri() ? {
  ...MOCK_RUNTIME,
  state: "stopped",
  uptimeSeconds: 0,
  endpoint: `http://${DEFAULT_CONFIG.host}:${DEFAULT_CONFIG.port}`,
  pid: undefined,
  processStartedAt: undefined,
  gpu: { name: "", utilization: 0, memoryUsedMiB: 0, memoryTotalMiB: 0, temperatureC: 0, powerW: 0, powerLimitW: 0, clockMHz: 0 },
  cpu: { name: "", utilization: 0, threads: 0, clockMHz: 0 },
  memory: { usedMiB: 0, totalMiB: 0 },
  generationTps: 0,
  promptTps: 0,
  activeRequests: 0,
  queuedRequests: 0,
  ttftMs: null,
  contextUsed: 0,
  contextTotal: 0,
  slots: [],
  metricsAvailable: false,
  slotsAvailable: false,
  healthStatus: 0,
} : MOCK_RUNTIME;
const makeNotice = (kind: AppNotice["kind"], message: string): AppNotice => ({ id: crypto.randomUUID(), kind, message, createdAt: Date.now() });
const benchmarkErrorMessage = (error: unknown) => {
  const details = String(error);
  return details.toLowerCase().includes("exact context tests require post") && /(?:404|405|not found|not supported)/i.test(details) && !details.includes("custom template")
    ? `${i18n.t("benchmark.tokenCountRequired")}\n${details}`
    : details;
};
const withNotice = (notices: AppNotice[], notice: AppNotice) => [...notices.slice(-4), notice];
const makeProfile = (config: LaunchConfig, existing?: LaunchProfile): LaunchProfile => ({
  id: config.profileId,
  name: config.profileName,
  description: existing?.description,
  config,
  createdAt: existing?.createdAt ?? now(),
  updatedAt: now(),
  lastUsedAt: existing?.lastUsedAt,
  lastKnownGood: existing?.lastKnownGood ?? false,
});
const routerRuntimeConfig = (config: LaunchConfig, settings: AppSettings): LaunchConfig => ({
  ...config,
  binaryPath: settings.binaryPath.trim() || config.binaryPath,
  host: settings.routerHost,
  port: settings.routerPort,
  apiKey: settings.routerApiKey,
  metrics: true,
  slots: true,
  webUi: false,
});
const ollamaRuntimeConfig = (config: LaunchConfig, settings: AppSettings): LaunchConfig => {
  const url = new URL(settings.ollamaEndpoint);
  return { ...config, engine: "ollama", engineModel: settings.ollamaModel, profileId: config.engine === "ollama" ? config.profileId : `ollama:${settings.ollamaModel}`, profileName: config.engine === "ollama" ? config.profileName : settings.ollamaModel, modelPath: "", modelAlias: settings.ollamaModel, ctxSize: settings.ollamaContext, host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), apiKey: "" };
};
const qwfnRuntimeConfig = (config: LaunchConfig, settings: AppSettings): LaunchConfig => ({
  ...config, engine: "qwfnfer", profileId: `qwfnfer:${settings.qwfn.modelPath}`, profileName: "Qwen3.8 Flash Next",
  binaryPath: settings.qwfn.binaryPath, modelPath: settings.qwfn.modelPath, modelAlias: "qwen3.8-flash-next",
  host: settings.qwfn.host, port: settings.qwfn.port, apiKey: settings.qwfn.apiKey, ctxSize: settings.qwfn.context,
  metrics: true, slots: false, webUi: false,
});
const routerSnapshotSettings = (settings: AppSettings): RouterRecoverySnapshot["settings"] => ({
  binaryPath: settings.binaryPath,
  serverMode: "router",
  routerHost: settings.routerHost,
  routerPort: settings.routerPort,
  routerMaxLoadedModels: settings.routerMaxLoadedModels,
  routerAutoload: settings.routerAutoload,
  routerApiKey: settings.routerApiKey,
});
const isLoopbackHost = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
const validationError = (config: LaunchConfig, capabilities: LlamaCapabilities) => {
  const invalid = validateConfig(config, capabilities).find(issue => issue.severity === "error");
  return invalid ? i18n.t(invalid.messageKey, {
    name: invalid.labelKey ? i18n.t(invalid.labelKey) : "",
    minimum: invalid.minimum,
    maximum: invalid.maximum,
  }) : undefined;
};

export const useControlStore = create<ControlState>((set, get) => ({
  activeView: "dashboard",
  config: DEFAULT_CONFIG,
  savedConfig: DEFAULT_CONFIG,
  capabilities: DEFAULT_CAPABILITIES,
  runtime: INITIAL_RUNTIME,
  runningConfig: undefined, runningMode: undefined, runningEngine: undefined, runningRouterSettings: undefined, launchPid: undefined, launchAttempt: 0, readyAttempt: 0,
  benchmarkEvents: [],
  history: [],
  logs: [],
  profiles: [], knownGoodProfile: undefined, knownGoodRouter: undefined, models: [], libraryModels: [], ollamaModels: [], strataModels: [], libraryErrors: [], devices: [], benchmarks: [], benchmarkSuites: [], optimizerProgress: undefined, optimizerRecommendation: undefined, optimizerProfiles: [], optimizerCancelRequested: false, optimizerRunning: false, notices: [], settings: DEFAULT_SETTINGS,
  dirty: false, initialized: false, busy: false,
  logFilter: "ALL", logSearch: "",

  setView: activeView => set({ activeView }),
  dismissNotice: id => set(state => ({ notices: state.notices.filter(notice => notice.id !== id) })),
  notify: (kind, message) => set(state => ({ notices: withNotice(state.notices, makeNotice(kind, message)) })),
  clearError: () => set({ error: undefined }),
  updateConfig: (key, value) => { if (get().optimizerRunning) return; set(state => ({ config: { ...state.config, [key]: value }, dirty: true })); },
  replaceConfig: (config, saved = false) => { if (!get().optimizerRunning) set({ config, savedConfig: saved ? config : get().savedConfig, dirty: !saved }); },
  saveConfigLocal: () => set(state => ({ savedConfig: state.config, dirty: false })),

  saveCurrentProfile: async () => {
    const state = get();
    if (state.optimizerRunning) return;
    const config = state.settings.serverEngine === "ollama" ? ollamaRuntimeConfig(state.config, state.settings) : structuredClone(state.config);
    const existing = state.profiles.find(p => p.id === config.profileId);
    const saved = await bridge.saveProfile(makeProfile(config, existing));
    set(s => {
      const stillMatches = JSON.stringify(s.config) === JSON.stringify(state.config) && (state.settings.serverEngine !== "ollama" || (s.settings.ollamaModel === state.settings.ollamaModel && s.settings.ollamaContext === state.settings.ollamaContext));
      return { profiles: [...s.profiles.filter(p => p.id !== saved.id), saved].sort((a,b)=>a.name.localeCompare(b.name)), ...(stillMatches ? { config, savedConfig: config, dirty: false } : {}), notices: withNotice(s.notices, makeNotice("success", i18n.t("notification.profileSaved"))) };
    });
    await get().syncRouterProfiles();
  },
  duplicateProfile: async name => {
    if (get().busy || get().optimizerRunning) return;
    const state = get();
    const base = state.settings.serverEngine === "ollama" ? ollamaRuntimeConfig(state.config, state.settings) : state.config;
    const id = crypto.randomUUID();
    const config = { ...base, profileId: id, profileName: name || `${base.profileName} Copy` };
    const saved = await bridge.saveProfile(makeProfile(config));
    set(s => ({ profiles: [...s.profiles, saved], config, savedConfig: config, dirty: false }));
    await get().syncRouterProfiles();
  },
  deleteProfile: async id => {
    await bridge.deleteProfile(id);
    const profiles = get().profiles.filter(p => p.id !== id);
    const next = profiles[0]?.config ?? DEFAULT_CONFIG;
    set(s => ({ profiles, config: s.config.profileId === id ? next : s.config, savedConfig: s.savedConfig.profileId === id ? next : s.savedConfig, dirty: false }));
    await get().syncRouterProfiles();
  },
  importProfile: async path => {
    const imported = await bridge.importProfile(path);
    set(state => ({ profiles: [imported, ...state.profiles.filter(profile => profile.id !== imported.id)], notices: withNotice(state.notices, makeNotice("success", i18n.t("notification.profileImported"))) }));
    await get().syncRouterProfiles();
  },
  syncRouterProfiles: async () => {
    const sync = routerSyncQueue.catch(() => undefined).then(async () => {
      const state = get();
      if (state.runningEngine !== "llama_cpp" || state.runningMode !== "router" || !state.runningRouterSettings) return;
      try { await bridge.refreshRouterProfiles({ ...state.settings, ...state.runningRouterSettings }, state.profiles, state.capabilities); }
      catch (error) { set({ error: `Router: ${String(error)}` }); throw error; }
    });
    routerSyncQueue = sync;
    await sync;
  },
  exportProfile: async (id, path) => { await bridge.exportProfile(id, path); set(state => ({ notices: withNotice(state.notices, makeNotice("success", i18n.t("notification.profileExported"))) })); },
  selectLibraryModel: async (id, engine) => {
    const state = get();
    if (state.busy || state.optimizerRunning) return false;
    const model = state.libraryModels.find(model => model.id === id);
    if (!model || !supportsEngine(model, engine)) { set({ error: i18n.t("models.engineUnsupported", { engine: ENGINE_NAMES[engine] }) }); return false; }
    if (engine === "llama_cpp") {
      const source = model.sources.llama_cpp!;
      set({ config: { ...DEFAULT_CONFIG, binaryPath: state.settings.binaryPath, engine, engineModel: undefined, profileId: crypto.randomUUID(), profileName: model.name, modelPath: source.path, modelBytes: source.sizeBytes, modelAlias: model.name, ...modelLaunchMetadata(source) }, dirty: true });
      await get().updateSettings({ serverEngine: engine });
      if (!state.capabilities.rawHelp) await get().detectBinary();
    } else if (engine === "qwfnfer") {
      await get().updateSettings({ serverEngine: engine, qwfn: { ...state.settings.qwfn, modelPath: model.sources.qwfnfer!.path } });
    } else if (engine === "strata") {
      await get().updateSettings({ serverEngine: engine, strataConfigPath: model.sources.strata!.configPath });
    } else {
      const name = model.sources.ollama!.name;
      const existing = state.profiles.find(profile => profile.config.engine === "ollama" && profile.config.engineModel === name);
      set({ config: existing?.config ?? { ...DEFAULT_CONFIG, engine, engineModel: name, profileId: crypto.randomUUID(), profileName: name, modelAlias: name, ctxSize: state.settings.ollamaContext }, dirty: !existing });
      await get().updateSettings({ serverEngine: engine, ollamaModel: name, ...(existing ? { ollamaContext: existing.config.ctxSize } : {}) });
    }
    return true;
  },
  selectProfile: async id => {
    if (get().busy || get().optimizerRunning) return;
    const profile = get().profiles.find(p => p.id === id);
    if (profile) {
      const config = withConfiguredBinary(profile.config, get().settings.binaryPath);
      const engine = profile.config.engine ?? "llama_cpp";
      set({ config: structuredClone(config), savedConfig: structuredClone(config), dirty: false });
      await get().updateSettings({ serverEngine: engine, ...(engine === "ollama" ? { ollamaModel: profile.config.engineModel ?? "", ollamaContext: profile.config.ctxSize } : {}) });
    }
  },

  setServerState: state => set(s => s.runtime.state === "stopping" ? {} : ({ runtime: { ...s.runtime, state } })),
  start: async (profileId) => {
    const initial = get();
    if (initial.busy || initial.optimizerRunning) return;
    if (initial.settings.serverEngine === "ollama") {
      if (initial.runningEngine && initial.runningEngine !== "ollama") { set({ error: "Stop the running engine before starting Ollama." }); return; }
      set({ busy: true, error: undefined });
      try {
        await startOllama(initial.settings.ollamaEndpoint, initial.settings.ollamaBinaryPath);
        const models = await ollamaLibrary(initial.settings.ollamaEndpoint);
        if (!models.some(model => model.name === initial.settings.ollamaModel && model.capabilities?.includes("completion"))) throw new Error(i18n.t("models.engineUnsupported", { engine: "Ollama" }));
        set({ ollamaModels: models, ollamaConnectionError: undefined });
        await ollamaAction(initial.settings.ollamaEndpoint, initial.settings.ollamaModel, "load", initial.settings.ollamaContext);
        set({ runningConfig: ollamaRuntimeConfig(initial.config, initial.settings), runningEngine: "ollama", runningMode: "single", runningOllamaSettings: { ollamaEndpoint: initial.settings.ollamaEndpoint, ollamaModel: initial.settings.ollamaModel, ollamaContext: initial.settings.ollamaContext }, runningRouterSettings: undefined });
        await get().refreshRuntime();
      } catch (error) { set({ error: String(error) }); }
      finally { set({ busy: false }); }
      return;
    }
    if (["strata", "qwfnfer"].includes(initial.settings.serverEngine)) {
      if (initial.settings.serverEngine === "strata" ? !initial.settings.strataConfigPath.trim() : !initial.settings.qwfn.modelPath.trim() || !initial.settings.qwfn.binaryPath.trim()) {
        set({ error: i18n.t(initial.settings.serverEngine === "qwfnfer" ? "qwfn.modelRequired" : "error.strataConfigRequired") });
        return;
      }
      const launchConfig = initial.settings.serverEngine === "qwfnfer" ? qwfnRuntimeConfig(initial.config, initial.settings) : strataRuntimeConfig(initial.config, initial.settings, initial.strataModels);
      set(s => ({ busy: true, error: undefined, runningConfig: launchConfig, runningMode: "single", runningEngine: initial.settings.serverEngine, runningRouterSettings: undefined, launchPid: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "starting" } }));
      const attempt = get().launchAttempt;
      try {
        const { pid } = await (initial.settings.serverEngine === "qwfnfer" ? bridge.startQwfnServer(initial.settings, false) : bridge.startStrataServer(initial.settings));
        set(s => s.launchAttempt === attempt ? ({ launchPid: pid, runtime: { ...s.runtime, state: "loading", pid } }) : {});
      } catch (error) {
        set(s => s.launchAttempt === attempt ? ({ runningConfig: undefined, runningMode: undefined, runningEngine: undefined, launchPid: undefined, runtime: { ...s.runtime, state: "crashed", lastError: String(error) }, error: String(error), notices: withNotice(s.notices, makeNotice("error", i18n.t("notification.serverFailed"))) }) : {});
      } finally { set({ busy: false }); }
      return;
    }
    const capabilities = initial.capabilities;
    if (!capabilities.rawHelp?.trim()) {
      set({ error: "llama.cpp capability detection is missing; run --version and --help before launch." });
      return;
    }
    const selectedProfile = profileId ? initial.profiles.find(profile => profile.id === profileId) : undefined;
    if (profileId && !selectedProfile) {
      set({ error: i18n.t("error.profileUnavailable") });
      return;
    }
    const config = withConfiguredBinary(structuredClone(selectedProfile?.config ?? initial.config), initial.settings.binaryPath);
    if (config.engine && config.engine !== "llama_cpp") { set({ error: i18n.t("models.engineUnsupported", { engine: "llama.cpp" }) }); return; }
    let profiles = initial.profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
    const mode: ServerMode = profileId ? "single" : initial.settings.serverMode;
    if (mode === "router") {
      if (!capabilities.modelsRouter) {
        set({ error: i18n.t("router.unsupportedBuild") });
        return;
      }
      if (!isLoopbackHost(initial.settings.routerHost) && !initial.settings.routerApiKey.trim()) {
        set({ error: i18n.t("router.apiKeyRequiredForNetwork") });
        return;
      }
      try {
        const saved = await bridge.saveProfile(makeProfile(config, profiles.find(profile => profile.id === config.profileId)));
        profiles = [...profiles.filter(profile => profile.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
        set(s => ({ profiles: [...s.profiles.filter(profile => profile.config.engine && profile.config.engine !== "llama_cpp"), ...profiles] }));
      } catch (error) {
        set({ error: String(error) });
        return;
      }
      const invalidProfile = profiles.find(profile => validationError(withConfiguredBinary(profile.config, initial.settings.binaryPath), capabilities));
      if (invalidProfile) {
        const reason = validationError(withConfiguredBinary(invalidProfile.config, initial.settings.binaryPath), capabilities);
        set({ error: i18n.t("router.invalidProfile", { name: invalidProfile.name, reason }) });
        return;
      }
    } else if (!capabilities.rawArguments.includes("--model")) {
      set({ error: "The selected llama-server build does not support --model." });
      return;
    }
    const invalid = validationError(config, capabilities);
    if (invalid) {
      set({ error: invalid });
      return;
    }
    if (config.engine && config.engine !== "llama_cpp") { set({ error: i18n.t("models.engineUnsupported", { engine: "llama.cpp" }) }); return; }
    try { await bridge.validateLlamaModels((mode === "router" ? profiles.map(profile => profile.config.modelPath) : [config.modelPath])); }
    catch (error) { set({ error: String(error) }); return; }
    const launchConfig = mode === "router" ? routerRuntimeConfig(config, initial.settings) : config;
    set(s => ({ busy: true, error: undefined, runningConfig: launchConfig, runningMode: mode, runningEngine: "llama_cpp", runningRouterSettings: mode === "router" ? routerSnapshotSettings(initial.settings) : undefined, launchPid: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "starting" } }));
    const attempt = get().launchAttempt;
    try {
      const result = mode === "router"
        ? await bridge.startRouter(launchConfig, initial.settings, profiles, capabilities)
        : await bridge.startServer(launchConfig, capabilities);
      const { pid } = result;
      const unsupportedCount = "unsupportedParameters" in result && Array.isArray(result.unsupportedParameters) ? result.unsupportedParameters.length : 0;
      if (unsupportedCount) {
        set(s => ({ notices: withNotice(s.notices, makeNotice("warning", i18n.t("router.unsupportedParameterCount", { count: unsupportedCount }))) }));
      }
      set(s => s.launchAttempt === attempt ? ({ launchPid: pid, runtime: { ...s.runtime, state: "loading", pid } }) : {});
    }
    catch (e) { set(s => s.launchAttempt === attempt ? ({ runningConfig: undefined, runningMode: undefined, runningEngine: undefined, runningRouterSettings: undefined, launchPid: undefined, runtime: { ...s.runtime, state: "crashed", lastError: String(e) }, error: String(e), notices: withNotice(s.notices, makeNotice("error", i18n.t("notification.serverFailed"))) }) : {}); }
    finally { set({ busy: false }); }
  },
  stop: async () => {
    const state = get();
    if (state.busy || state.optimizerRunning || state.runtime.state === "stopping") return;
    // Invalidate telemetry already in flight before changing the lifecycle state.
    set(s => ({ busy: true, error: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, state: "stopping" } }));
    const finishStop = () => set(s => ({
      runningConfig: undefined, runningMode: undefined, runningEngine: undefined,
      runningRouterSettings: undefined, runningOllamaSettings: undefined, launchPid: undefined,
      runtime: { ...s.runtime, state: "stopped", uptimeSeconds: 0, pid: undefined, processStartedAt: undefined,
        modelName: undefined, lastError: undefined, generationTps: 0, promptTps: 0, generationMeanTps: undefined,
        generationWindowSeconds: undefined, activeRequests: 0, queuedRequests: 0, ttftMs: null,
        contextUsed: 0, contextTotal: 0, slots: [], metricsAvailable: false, slotsAvailable: false, healthStatus: 0 },
      notices: withNotice(s.notices, makeNotice("info", i18n.t("notification.serverStopped"))),
    }));
    if (state.runningEngine === "ollama" || (!state.runningEngine && state.settings.serverEngine === "ollama")) {
      const settings = { ...state.settings, ...state.runningOllamaSettings };
      try { await ollamaAction(settings.ollamaEndpoint, settings.ollamaModel, "unload", settings.ollamaContext); finishStop(); }
      catch (error) { set(s => ({ error: String(error), runtime: { ...s.runtime, state: state.runtime.state } })); }
      finally { set({ busy: false }); }
      return;
    }
    try { await bridge.stopServer(); finishStop(); }
    catch (e) { set(s => ({ error: String(e), runtime: { ...s.runtime, state: state.runtime.state } })); }
    finally { set({ busy: false }); }
  },
  restart: async (profileId) => {
    const state = get();
    if (state.busy || state.optimizerRunning) return;
    if (state.settings.serverEngine === "ollama" || state.runningEngine === "ollama") {
      await get().stop();
      if (!get().error) await get().start(profileId);
      return;
    }
    if (["strata", "qwfnfer"].includes(state.settings.serverEngine)) {
      if (state.settings.serverEngine === "strata" ? !state.settings.strataConfigPath.trim() : !state.settings.qwfn.modelPath.trim() || !state.settings.qwfn.binaryPath.trim()) {
        set({ error: i18n.t(state.settings.serverEngine === "qwfnfer" ? "qwfn.modelRequired" : "error.strataConfigRequired") });
        return;
      }
      const launchConfig = state.settings.serverEngine === "qwfnfer" ? qwfnRuntimeConfig(state.config, state.settings) : strataRuntimeConfig(state.config, state.settings, state.strataModels);
      set(s => ({ busy: true, error: undefined, runningConfig: launchConfig, runningMode: "single", runningEngine: state.settings.serverEngine, runningRouterSettings: undefined, launchPid: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "restarting" } }));
      const attempt = get().launchAttempt;
      try {
        const { pid } = await (state.settings.serverEngine === "qwfnfer" ? bridge.startQwfnServer(state.settings, true) : bridge.restartStrataServer(state.settings));
        set(s => s.launchAttempt === attempt ? ({ launchPid: pid, runtime: { ...s.runtime, state: "loading", pid } }) : {});
      } catch (error) {
        set(s => s.launchAttempt === attempt ? ({ runningConfig: undefined, runningMode: undefined, runningEngine: undefined, launchPid: undefined, runtime: { ...s.runtime, state: "crashed", lastError: String(error) }, error: String(error), notices: withNotice(s.notices, makeNotice("error", i18n.t("notification.serverFailed"))) }) : {});
      } finally { set({ busy: false }); }
      return;
    }
    const selectedProfile = profileId ? state.profiles.find(profile => profile.id === profileId) : undefined;
    if (profileId && !selectedProfile) {
      set({ error: i18n.t("error.profileUnavailable") });
      return;
    }
    const config = withConfiguredBinary(structuredClone(selectedProfile?.config ?? state.config), state.settings.binaryPath);
    const mode: ServerMode = profileId ? "single" : state.settings.serverMode;
    if (!state.capabilities.rawHelp?.trim()) {
      set({ error: "llama.cpp capability detection is missing; run --version and --help before launch." });
      return;
    }
    if (mode === "router" && !state.capabilities.modelsRouter) {
      set({ error: i18n.t("router.unsupportedBuild") });
      return;
    }
    if (mode === "router" && !isLoopbackHost(state.settings.routerHost) && !state.settings.routerApiKey.trim()) {
      set({ error: i18n.t("router.apiKeyRequiredForNetwork") });
      return;
    }
    if (mode === "single" && !state.capabilities.rawArguments.includes("--model")) {
      set({ error: "The selected llama-server build does not support --model." });
      return;
    }
    const invalid = validationError(config, state.capabilities);
    if (invalid) {
      set({ error: invalid });
      return;
    }
    if (config.engine && config.engine !== "llama_cpp") { set({ error: i18n.t("models.engineUnsupported", { engine: "llama.cpp" }) }); return; }
    let profiles = state.profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp");
    try {
      const saved = await bridge.saveProfile(makeProfile(config, profiles.find(profile => profile.id === config.profileId)));
      profiles = [...profiles.filter(profile => profile.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
      set(s => ({ profiles: [...s.profiles.filter(profile => profile.config.engine && profile.config.engine !== "llama_cpp"), ...profiles] }));
    } catch (error) {
      set({ error: String(error) });
      return;
    }
    if (mode === "router") {
      const invalidProfile = profiles.find(profile => validationError(withConfiguredBinary(profile.config, state.settings.binaryPath), state.capabilities));
      if (invalidProfile) {
        const reason = validationError(withConfiguredBinary(invalidProfile.config, state.settings.binaryPath), state.capabilities);
        set({ error: i18n.t("router.invalidProfile", { name: invalidProfile.name, reason }) });
        return;
      }
    }
    if (config.engine && config.engine !== "llama_cpp") { set({ error: i18n.t("models.engineUnsupported", { engine: "llama.cpp" }) }); return; }
    try { await bridge.validateLlamaModels(mode === "router" ? profiles.map(profile => profile.config.modelPath) : [config.modelPath]); }
    catch (error) { set({ error: String(error) }); return; }
    const launchConfig = mode === "router" ? routerRuntimeConfig(config, state.settings) : config;
    set(s => ({ busy: true, error: undefined, runningConfig: launchConfig, runningMode: mode, runningEngine: "llama_cpp", runningRouterSettings: mode === "router" ? routerSnapshotSettings(state.settings) : undefined, launchPid: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "restarting" } }));
    const attempt = get().launchAttempt;
    try {
      const result = mode === "router"
        ? await bridge.restartRouter(launchConfig, state.settings, profiles, state.capabilities)
        : await bridge.restartServer(launchConfig, state.capabilities);
      const { pid } = result;
      const unsupportedCount = "unsupportedParameters" in result && Array.isArray(result.unsupportedParameters) ? result.unsupportedParameters.length : 0;
      if (unsupportedCount) {
        set(s => ({ notices: withNotice(s.notices, makeNotice("warning", i18n.t("router.unsupportedParameterCount", { count: unsupportedCount }))) }));
      }
      set(s => s.launchAttempt === attempt ? ({ launchPid: pid, savedConfig: JSON.stringify(s.config) === JSON.stringify(config) ? config : s.savedConfig, dirty: JSON.stringify(s.config) === JSON.stringify(config) ? false : s.dirty, runtime: { ...s.runtime, state: "loading", pid } }) : {});
    } catch (e) {
      set(s => s.launchAttempt === attempt ? ({ runningConfig: undefined, runningMode: undefined, runningEngine: undefined, runningRouterSettings: undefined, launchPid: undefined, runtime: { ...s.runtime, state: "crashed", lastError: String(e) }, error: String(e), notices: withNotice(s.notices, makeNotice("error", i18n.t("notification.serverFailed"))) }) : {});
    } finally { set({ busy: false }); }
  },
  rollback: async () => {
    if (get().settings.serverEngine !== "llama_cpp") return;
    if (get().settings.serverMode === "router") {
      try {
        const snapshot = await bridge.restoreLastKnownGoodRouter();
        const settings = await bridge.getSettings();
        await i18n.changeLanguage(settings.language);
        set({ profiles: await bridge.listProfiles(), settings, knownGoodRouter: snapshot, config: snapshot.config, savedConfig: snapshot.config, dirty: false });
        await get().restart();
      } catch (error) {
        set({ error: String(error) });
      }
      return;
    }
    const profile = await bridge.loadLastKnownGood();
    if (!profile) return;
    set({ config: profile.config, savedConfig: profile.config, dirty: false });
    await get().restart();
  },
  refreshRuntime: async () => {
    if (runtimeRefreshInFlight || get().runtime.state === "stopping") return;
    runtimeRefreshInFlight = true;
    const state = get();
    const isCurrent = () => get().launchAttempt === state.launchAttempt && get().runtime.state !== "stopping";
    try {
      const engine = state.runningEngine ?? state.settings.serverEngine;
      if (engine === "ollama") {
        const settings = { ...state.settings, ...state.runningOllamaSettings };
        if (!bridge.isTauri()) { set({ runtime: { ...MOCK_RUNTIME, state: "stopped", backend: "Ollama", endpoint: settings.ollamaEndpoint } }); return; }
        const runtime = await ollamaRuntime(settings.ollamaEndpoint, settings.ollamaModel);
        if (!isCurrent()) return;
        set(s => ({ runtime, history: appendRuntimeHistory(s.history, runtime), ...(!s.runningEngine && runtime.state === "ready" ? { runningEngine: "ollama", runningMode: "single", runningConfig: ollamaRuntimeConfig(s.config, settings), runningOllamaSettings: { ollamaEndpoint: settings.ollamaEndpoint, ollamaModel: settings.ollamaModel, ollamaContext: runtime.contextTotal || settings.ollamaContext } } : {}) }));
        return;
      }
      const observedConfig = state.runningConfig ?? (engine === "strata"
        ? strataRuntimeConfig(state.config, state.settings, state.strataModels)
        : engine === "qwfnfer" ? qwfnRuntimeConfig(state.config, state.settings) : state.settings.serverMode === "router" ? routerRuntimeConfig(state.config, state.settings) : state.config);
      const runtime = await bridge.getRuntime(observedConfig, engine === "llama_cpp" && (state.runningMode ?? state.settings.serverMode) === "router", engine);
      if (!isCurrent()) return;
      set(s => ({
        runtime,
        history: appendRuntimeHistory(s.history, runtime),
        ...(runtime.state === "crashed" && s.runtime.state !== "crashed" ? {
          error: runtime.lastError ?? "llama-server exited unexpectedly",
          notices: withNotice(s.notices, makeNotice("error", i18n.t("notification.serverFailed"))),
        } : {}),
      }));
      const refreshed = get();
      // Trial launches must never become the saved config or last-known-good snapshot.
      if (refreshed.optimizerRunning) return;
      if (shouldCommitReadyLaunch(runtime.state, runtime.pid, refreshed.launchPid, refreshed.launchAttempt, refreshed.readyAttempt) && ["strata", "qwfnfer"].includes(refreshed.runningEngine ?? "")) {
        set(s => s.launchAttempt === refreshed.launchAttempt && s.launchPid === runtime.pid ? {
          readyAttempt: refreshed.launchAttempt,
          notices: withNotice(s.notices, makeNotice("success", i18n.t("notification.serverStarted"))),
        } : {});
      } else if (shouldCommitReadyLaunch(runtime.state, runtime.pid, refreshed.launchPid, refreshed.launchAttempt, refreshed.readyAttempt) && refreshed.runningEngine === "llama_cpp" && refreshed.runningConfig && refreshed.runningMode === "router") {
        const snapshot: RouterRecoverySnapshot = {
          profiles: structuredClone(refreshed.profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp")),
          config: structuredClone(refreshed.profiles.find(profile => profile.id === refreshed.runningConfig?.profileId)?.config ?? refreshed.runningConfig),
          settings: refreshed.runningRouterSettings ?? routerSnapshotSettings(refreshed.settings),
        };
        await bridge.markRouterGood(snapshot);
        if (get().launchAttempt !== refreshed.launchAttempt || get().launchPid !== runtime.pid) return;
        set(s => s.launchAttempt === refreshed.launchAttempt && s.launchPid === runtime.pid ? {
          readyAttempt: refreshed.launchAttempt,
          knownGoodRouter: snapshot,
          notices: withNotice(s.notices, makeNotice("success", i18n.t("notification.serverStarted"))),
        } : {});
      } else if (shouldCommitReadyLaunch(runtime.state, runtime.pid, refreshed.launchPid, refreshed.launchAttempt, refreshed.readyAttempt) && refreshed.runningEngine === "llama_cpp" && refreshed.runningConfig && refreshed.runningMode === "single") {
        const config = structuredClone(refreshed.runningConfig);
        const existing = refreshed.profiles.find(profile => profile.id === config.profileId);
        const saved = await bridge.saveProfile(makeProfile(config, existing));
        if (get().launchAttempt !== refreshed.launchAttempt || get().launchPid !== runtime.pid) return;
        await bridge.markProfileGood(config.profileId);
        const stamp = now();
        set(s => {
          if (s.launchAttempt !== refreshed.launchAttempt || s.launchPid !== runtime.pid) return {};
          const currentStillMatches = JSON.stringify(s.config) === JSON.stringify(config);
          return {
            readyAttempt: refreshed.launchAttempt,
            profiles: [...s.profiles.filter(profile => profile.id !== saved.id), { ...saved, lastKnownGood: true, lastUsedAt: stamp }].map(profile => profile.id === saved.id ? profile : { ...profile, lastKnownGood: false }),
            knownGoodProfile: { ...saved, lastKnownGood: true, lastUsedAt: stamp },
            ...(currentStillMatches ? { savedConfig: config, dirty: false } : {}),
            notices: withNotice(s.notices, makeNotice("success", i18n.t("notification.serverStarted"))),
          };
        });
      }
    } catch (e) { if (isCurrent()) set({ error: String(e) }); }
    finally { runtimeRefreshInFlight = false; }
  },
  appendLog: line => set(state => ({ logs: [...state.logs.slice(-(state.settings.logRetentionLines - 1)), line] })),
  clearLogs: () => set({ logs: [] }),
  setLogFilter: logFilter => set({ logFilter }),
  setLogSearch: logSearch => set({ logSearch }),

  detectBinary: async binaryPath => {
    set({ busy: true, error: undefined });
    try { const detected = await bridge.detectLlama(binaryPath || get().settings.binaryPath || get().config.binaryPath); set({ capabilities: detected.capabilities, devices: detected.devices }); }
    catch (e) { set({ error: String(e) }); }
    finally { set({ busy: false }); }
  },
  rescanModels: async () => {
    if (get().optimizerRunning) return;
    set({ busy: true });
    try {
      const settings = get().settings;
      const results = await Promise.allSettled([bridge.scanModels([...new Set([...settings.modelDirectories, ...get().profiles.filter(p => !p.config.engine || p.config.engine === "llama_cpp").map(p => p.config.modelPath.replace(/[\\/][^\\/]+$/, "")).filter(Boolean)])]), settings.strataRootPath ? bridge.discoverStrataModels(settings.strataRootPath) : Promise.resolve([]), bridge.isTauri() ? ollamaLibrary(settings.ollamaEndpoint) : Promise.resolve([])]);
      const strataModels = results[1].status === "fulfilled" ? results[1].value : [];
      const extraRoots = [...new Set([settings.qwfn.modelPath, ...strataModels.map(model => model.modelPath ?? "")].filter(path => /\.gguf$/i.test(path)).map(path => path.replace(/[\\/][^\\/]+$/, "")))];
      const extraModels = extraRoots.length ? await bridge.scanModels(extraRoots).catch(() => []) : [];
      const models = [...(results[0].status === "fulfilled" ? results[0].value : []), ...extraModels].filter((model, index, all) => all.findIndex(candidate => candidate.path === model.path) === index);
      const ollamaModels = results[2].status === "fulfilled" ? results[2].value : bridge.isTauri() ? await ollamaCachedLibrary(settings.ollamaEndpoint).catch(() => get().ollamaModels) : get().ollamaModels;
      set({ models: [...models, ...ollamaModels.flatMap(model => model.ggufModel ? [model.ggufModel] : [])].filter((model, index, items) => items.findIndex(candidate => candidate.path === model.path) === index), strataModels, ollamaModels, libraryModels: buildEngineModels(models, strataModels, ollamaModels), ollamaConnectionError: results[2].status === "rejected" ? String(results[2].reason) : undefined, libraryErrors: results.flatMap((result, index) => result.status === "rejected" && index !== 2 ? [`${["llama.cpp", "Strata", "Ollama"][index]}: ${String(result.reason)}`] : []) });
    }
    catch (e) { set({ error: String(e) }); }
    finally { set({ busy: false }); }
  },
  updateSettings: async patch => {
    if (get().optimizerRunning) throw new Error(i18n.t("benchmark.tuningStarting"));
    const next = { ...get().settings, ...patch };
    const saved = await bridge.saveSettings(next);
    await i18n.changeLanguage(saved.language);
    if (patch.startWithWindows !== undefined) await syncWindowsAutostart(saved.startWithWindows);
    set(state => ({ settings: saved, notices: withNotice(state.notices, makeNotice("success", i18n.t("notification.settingsSaved"))), ...(patch.binaryPath ? { config: { ...state.config, binaryPath: saved.binaryPath }, dirty: true } : {}) }));
  },
  runBenchmark: async request => {
    if (request.autoSelectProfiles) { await get().runAutoTune(request); return; }
    set({ busy: true, error: undefined });
    try {
      const state = get();
      const config = state.runningConfig;
      if (state.runningEngine === "ollama") {
        if (!config || !["ready", "busy"].includes(state.runtime.state)) throw new Error(i18n.t("benchmark.profileMustBeRunning"));
        const settings = { ...state.settings, ...state.runningOllamaSettings };
        const result = await benchmarkOllama(settings.ollamaEndpoint, settings.ollamaModel, settings.ollamaContext, { ...request, profileId: config.profileId }, config.profileName);
        set(s => ({ benchmarks: [result, ...s.benchmarks] }));
        return;
      }
      const strataMode = ["strata", "qwfnfer"].includes(state.runningEngine ?? "");
      const profileId = strataMode ? state.runningEngine! : request.profileId ?? config?.profileId;
      if (!config || !profileId || !["ready", "busy"].includes(state.runtime.state)) {
        throw new Error(i18n.t("benchmark.profileMustBeRunning"));
      }
      const routerMode = state.runningMode === "router";
      const profile = state.profiles.find(candidate => candidate.id === profileId);
      if (!strataMode && routerMode && !profile) throw new Error(i18n.t("benchmark.profileMustBeRunning"));
      if (!strataMode && !routerMode && profileId !== config.profileId) throw new Error(i18n.t("benchmark.profileMustBeRunning"));
      const benchmarkConfig = routerMode ? routerRuntimeConfig(profile!.config, state.settings) : config;
      const modelName = state.runtime.modelName ?? config.modelAlias ?? state.runningEngine ?? "strata";
      const usesChatSuite = state.benchmarkSuites.some(suite => suite.id === request.suiteId && suite.kind !== "throughput");
      const model = strataMode ? modelName : routerMode && profile ? profile.name : usesChatSuite ? config.modelAlias?.trim() || config.profileName : request.model;
      const benchmarkRequest = { ...request, profileId, ...(model ? { model } : {}), configSnapshot: strataMode ? config : profile?.config ?? config };
      const profileName = strataMode ? modelName : profile?.name ?? config.profileName;
      const result = benchmarkRequest.suiteId
        ? await bridge.runBenchmarkSuite(benchmarkRequest, benchmarkConfig, profileName)
        : await bridge.runBenchmark(benchmarkRequest, benchmarkConfig, profileName);
      set(s => ({ benchmarks: [result, ...s.benchmarks] }));
    }
    catch (e) { set({ error: benchmarkErrorMessage(e) }); }
    finally { set({ busy: false }); }
  },
  runAutoTune: async request => {
    const initial = get();
    if (initial.busy || initial.optimizerRunning) return;
    const routerMode = initial.runningMode === "router";
    const originalRuntimeConfig = initial.runningConfig && structuredClone(initial.runningConfig);
    const profileId = request.profileId ?? originalRuntimeConfig?.profileId;
    const profile = initial.profiles.find(candidate => candidate.id === profileId);
    if (!bridge.isTauri()) {
      set({ error: i18n.t("benchmark.autoTuneDesktopOnly") });
      return;
    }
    if (initial.runningEngine !== "llama_cpp" || !originalRuntimeConfig || !profileId || (routerMode && !profile) || (!routerMode && profileId !== originalRuntimeConfig.profileId)) {
      set({ error: i18n.t(initial.runningEngine === "strata" ? "benchmark.autoTuneStrataUnsupported" : "benchmark.profileMustBeRunning") });
      return;
    }
    if (!["ready", "busy"].includes(initial.runtime.state)) {
      set({ error: i18n.t("benchmark.profileMustBeRunning") });
      return;
    }
    const recallSuite = initial.benchmarkSuites.find(suite => suite.id === "context-recall-v1");
    const stabilitySuite = initial.benchmarkSuites.find(suite => suite.id === "context-stability-v1");
    if (!recallSuite || !stabilitySuite) {
      set({ error: i18n.t("benchmark.suitesUnavailable") });
      return;
    }
    const effectiveSettings = { ...initial.settings, ...(initial.runningRouterSettings ?? {}) };
    const baseConfig = withConfiguredBinary(structuredClone(routerMode ? profile!.config : originalRuntimeConfig), effectiveSettings.binaryPath);
    // Exact suites use the model's chat template; preserve the original launch for restoration.
    if (initial.capabilities.rawArguments.includes("--jinja")) baseConfig.jinja = true;
    const profileSearch = request.autoSelectProfiles === true;
    const minimumContext = request.minimumContextTokens ?? MINIMUM_AGENT_CONTEXT;
    if (profileSearch && (!Number.isInteger(request.promptTokens) || request.promptTokens < 1
      || !Number.isInteger(request.generationTokens) || request.generationTokens < 1 || request.generationTokens > minimumContext - 1024
      || !Number.isInteger(request.runs) || request.runs < 1 || request.runs > 20
      || (request.minimumQuality !== undefined && (!Number.isFinite(request.minimumQuality) || request.minimumQuality < 0 || request.minimumQuality > 1)))) {
      set({ error: i18n.t("benchmark.profileSearchInvalidMeasurements") }); return;
    }
    const modelContext = initial.models.find(model => model.path.toLowerCase().replaceAll("\\", "/") === baseConfig.modelPath.toLowerCase().replaceAll("\\", "/"))?.contextLength;
    const maximumContext = Math.min(request.maximumContextTokens ?? Math.max(baseConfig.ctxSize, DEFAULT_SEARCH_CONTEXT), modelContext && modelContext > 0 ? modelContext : Infinity);
    const candidates = profileSearch
      ? buildProfileSearchCandidates(baseConfig, initial.capabilities, minimumContext, maximumContext)
      : buildBenchmarkCandidates(baseConfig, initial.capabilities);
    if (!candidates.length) { set({ error: i18n.t("benchmark.profileSearchUnavailable") }); return; }
    const totalSteps = profileSearch ? candidates.length * 3 : candidates.length + Math.min(3, candidates.length);
    const screened: BenchmarkResult[] = [];
    const selected: { goal: BenchmarkProfileGoal; result: BenchmarkResult; verification: BenchmarkResult }[] = [];
    let step = 0;
    let best: BenchmarkResult | undefined;
    let firstCandidateError: unknown;

    const launchCandidate = async (candidateConfig: LaunchConfig) => {
      const launchConfig = routerMode ? routerRuntimeConfig(candidateConfig, effectiveSettings) : candidateConfig;
      set(state => ({
        runningConfig: launchConfig,
        runtime: { ...state.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "restarting" },
      }));
      const launchResult = routerMode
        ? await bridge.restartRouter(launchConfig, effectiveSettings, initial.profiles.map(existing => existing.id === profileId ? { ...existing, config: candidateConfig } : existing), initial.capabilities)
        : await bridge.restartServer(launchConfig, initial.capabilities);
      set(state => ({ launchPid: launchResult.pid, runtime: { ...state.runtime, state: "loading", pid: launchResult.pid } }));
      const runtime = await waitForServerReady(launchConfig, routerMode);
      set({ runtime, launchPid: runtime.pid ?? launchResult.pid });
      if (runtime.state !== "ready" && runtime.state !== "busy") {
        throw new Error(runtime.lastError || `Server did not become ready (state: ${runtime.state}).`);
      }
      return launchConfig;
    };

    set({ busy: true, optimizerRunning: true, error: undefined, optimizerRecommendation: undefined, optimizerProfiles: [], optimizerCancelRequested: false, optimizerProgress: { current: 0, total: totalSteps, candidate: i18n.t("benchmark.tuningStarting") } });
    try {
      for (const candidate of candidates) {
        if (get().optimizerCancelRequested) break;
        step += 1;
        set({ optimizerProgress: { current: step, total: totalSteps, candidate: candidate.id } });
        try {
          const launchConfig = await launchCandidate(candidate.config);
          const model = routerMode ? profile!.name : candidate.config.modelAlias?.trim() || candidate.config.profileName;
          const result = await bridge.runBenchmarkSuite({
            ...request,
            profileId,
            model,
            suiteId: recallSuite.id,
            suiteVersion: recallSuite.version,
            generationTokens: Math.max(request.generationTokens, recallSuite.defaultGenerationTokens),
            runs: 1,
            windowCount: 1,
            minimumQuality: request.minimumQuality ?? recallSuite.minimumAccuracy ?? 0.95,
            ...(profileSearch ? { promptTokens: candidate.config.ctxSize, minimumGenerationTps: undefined } : {}),
            contextLimitTokens: candidate.config.ctxSize,
            configSnapshot: candidate.config,
            autoTuneCandidate: true,
          }, launchConfig, `${profile?.name ?? candidate.config.profileName} · ${candidate.id}`);
          set(state => ({ benchmarks: [result, ...state.benchmarks] }));
          if (!profileSearch) { screened.push(result); }
          else if (result.meetsTargets && result.suiteSummary?.passed && !get().optimizerCancelRequested) {
            step += 1;
            set({ optimizerProgress: { current: step, total: totalSteps, candidate: `${candidate.id} · ${i18n.t("benchmark.suite.throughput.name")}` } });
            const throughput = await bridge.runBenchmarkSuite({
              ...request, profileId, model,
              suiteId: "throughput-v1", suiteVersion: 1, objective: "speed", minimumQuality: undefined,
              // Use identical short prompts for decode comparisons, regardless of the chosen quality suite.
              promptTokens: Math.min(request.promptTokens, minimumContext - request.generationTokens - 256),
              contextLimitTokens: candidate.config.ctxSize, configSnapshot: candidate.config,
              autoTuneCandidate: true,
            }, launchConfig, `${profile?.name ?? candidate.config.profileName} · ${candidate.id} · ${i18n.t("benchmark.suite.throughput.name")}`);
            screened.push(throughput);
            set(state => ({ benchmarks: [throughput, ...state.benchmarks] }));
          }
        } catch (error) {
          firstCandidateError ??= error;
          set({ optimizerProgress: { current: step, total: totalSteps, candidate: `${candidate.id} — ${String(error)}` } });
          if (String(error).includes("exact context tests require POST")) break;
        }
      }

      const finalists = screened
        .filter(result => result.meetsTargets)
        .sort((a, b) => (b.recommendationScore ?? 0) - (a.recommendationScore ?? 0))
        .slice(0, 3);
      const verificationCache = new Map<string, BenchmarkResult | null>();
      const goals: (BenchmarkProfileGoal | undefined)[] = profileSearch ? ["maxContext", "maxSpeed", "balanced"] : [undefined];
      for (const goal of goals) {
        const ranked = goal ? rankProfileResults(screened.filter(result => {
          const signature = JSON.stringify(result.configSnapshot);
          return !verificationCache.has(signature) || verificationCache.get(signature) !== null;
        }), goal, minimumContext) : finalists;
        for (const screenedResult of get().optimizerCancelRequested ? [] : ranked) {
          if (get().optimizerCancelRequested) break;
          const config = screenedResult.configSnapshot as LaunchConfig | null | undefined;
          if (!config) continue;
          const signature = JSON.stringify(config);
          if (verificationCache.has(signature)) {
            const verification = verificationCache.get(signature);
            if (goal && verification) { selected.push({ goal, result: screenedResult, verification }); break; }
            continue;
          }
          verificationCache.set(signature, null);
          step += 1;
          set({ optimizerProgress: { current: step, total: totalSteps, candidate: `${config.profileName} · ${i18n.t("benchmark.stabilityVerification")}` } });
          try {
            const launchConfig = await launchCandidate(config);
            const model = routerMode ? profile!.name : config.modelAlias?.trim() || config.profileName;
            const verified = await bridge.runBenchmarkSuite({
              ...request,
              profileId,
              model,
              suiteId: stabilitySuite.id,
              suiteVersion: stabilitySuite.version,
              generationTokens: Math.max(request.generationTokens, stabilitySuite.defaultGenerationTokens),
              runs: stabilitySuite.defaultRuns,
              windowCount: stabilitySuite.windowCount,
              minimumQuality: request.minimumQuality ?? stabilitySuite.minimumAccuracy ?? 0.95,
              ...(profileSearch ? { promptTokens: config.ctxSize, minimumGenerationTps: undefined } : {}),
              contextLimitTokens: config.ctxSize,
              configSnapshot: config,
              autoTuneCandidate: true,
            }, launchConfig, `${profile?.name ?? config.profileName} · ${i18n.t("benchmark.stabilityVerification")}`);
            set(state => ({ benchmarks: [verified, ...state.benchmarks] }));
            if (verified.meetsTargets && verified.suiteSummary?.passed) {
              verificationCache.set(signature, verified);
              if (goal) selected.push({ goal, result: screenedResult, verification: verified });
              else best = verified;
              break;
            }
          } catch (error) {
            set({ optimizerProgress: { current: step, total: totalSteps, candidate: `${config.profileName} — ${String(error)}` } });
          }
        }
      }
      if (get().optimizerCancelRequested) {
        set({ optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.tuningCancelled") } });
      } else if (profileSearch && selected.length) {
        set({ optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.restoringBeforeSave") } });
      } else if (best) {
        set(state => ({ optimizerRecommendation: best, optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.tuningComplete") }, notices: withNotice(state.notices, makeNotice("success", i18n.t("benchmark.tuningRecommendationReady"))) }));
      } else {
        set({ optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.noPassingCandidate") }, ...(firstCandidateError ? { error: benchmarkErrorMessage(firstCandidateError) } : {}) });
      }
    } catch (error) {
      set({ error: benchmarkErrorMessage(error) });
    } finally {
      let restoredSuccessfully = false;
      try {
        const restoredConfig = routerMode ? routerRuntimeConfig(originalRuntimeConfig, effectiveSettings) : originalRuntimeConfig;
        set(state => ({ runningConfig: restoredConfig, runtime: { ...state.runtime, endpoint: `http://${restoredConfig.host}:${restoredConfig.port}`, state: "restarting" } }));
        const restored = routerMode
          ? await bridge.restartRouter(restoredConfig, effectiveSettings, initial.profiles, initial.capabilities)
          : await bridge.restartServer(restoredConfig, initial.capabilities);
        set(state => ({ launchPid: restored.pid, runtime: { ...state.runtime, state: "loading", pid: restored.pid } }));
        const runtime = await waitForServerReady(restoredConfig, routerMode);
        if (runtime.state !== "ready" && runtime.state !== "busy") throw new Error(runtime.lastError || `Restore ended in state ${runtime.state}.`);
        set({ runningConfig: restoredConfig, runtime, launchPid: runtime.pid ?? restored.pid });
        restoredSuccessfully = true;
      } catch (restoreError) {
        set(state => ({ runningConfig: undefined, runningMode: undefined, runningEngine: undefined, launchPid: undefined, runtime: { ...state.runtime, state: "crashed", lastError: String(restoreError) }, error: i18n.t("benchmark.restoreAfterTuningFailed", { error: String(restoreError) }) }));
      } finally {
        if (restoredSuccessfully && profileSearch && !get().optimizerCancelRequested && selected.length) {
          try {
            for (const selection of selected) {
              if (get().optimizerCancelRequested) break;
              const config = structuredClone(selection.result.configSnapshot as LaunchConfig);
              config.profileId = crypto.randomUUID();
              config.profileName = `${profile?.name ?? baseConfig.profileName} · ${i18n.t(`benchmark.profileGoal.${selection.goal}`)} · ${config.ctxSize.toLocaleString(initial.settings.language)}`;
              const saved = await bridge.saveProfile({ ...makeProfile(config), description: i18n.t("benchmark.autoProfileDescription", {
                contextTokens: config.ctxSize, speed: selection.result.averages.generationTps.toFixed(1),
                benchmarkId: selection.result.id, verificationId: selection.verification.id,
              }) });
              set(state => ({ profiles: [...state.profiles, saved], optimizerProfiles: [...state.optimizerProfiles, { ...selection, profile: saved }] }));
            }
            if (get().optimizerProfiles.length) {
              await get().syncRouterProfiles();
              set(state => ({ notices: withNotice(state.notices, makeNotice("success", i18n.t("benchmark.profilesSaved", { count: state.optimizerProfiles.length }))), optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.tuningComplete") } }));
            }
          } catch (saveError) { set({ error: i18n.t("benchmark.profileSaveFailed", { error: String(saveError) }) }); }
        }
        set({ busy: false, optimizerCancelRequested: false, optimizerRunning: false });
      }
    }
  },
  cancelAutoTune: () => { if (get().optimizerRunning) set({ optimizerCancelRequested: true }); },
  applyOptimizerRecommendation: () => {
    const recommendation = get().optimizerRecommendation;
    const config = recommendation?.configSnapshot;
    if (config && !get().busy && !get().optimizerRunning) set({ config: structuredClone(config as LaunchConfig), dirty: true });
  },

  initialize: async () => {
    if (get().initialized) return;
    try {
      const [storedSettings, profiles, benchmarks, benchmarkSuites, knownGoodProfile, knownGoodRouter] = await Promise.all([bridge.getSettings(), bridge.listProfiles(), bridge.listBenchmarks(), bridge.listBenchmarkSuites(), bridge.loadLastKnownGood(), bridge.loadLastKnownGoodRouter()]);
      let settings = { ...DEFAULT_SETTINGS, ...storedSettings, qwfn: { ...DEFAULT_SETTINGS.qwfn, ...storedSettings.qwfn } };
      if (!storedSettings.routerApiKey.trim()) settings = await bridge.saveSettings({ ...settings, routerApiKey: generateRouterApiKey() });
      if (!storedSettings.setupCompleted) {
        const detectedLanguage = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
        if (detectedLanguage !== settings.language) settings = await bridge.saveSettings({ ...settings, language: detectedLanguage });
      }
      await i18n.changeLanguage(settings.language);
      const selected = profiles.find(profile => (profile.config.engine ?? "llama_cpp") === settings.serverEngine && (settings.serverEngine !== "ollama" || profile.config.engineModel === settings.ollamaModel));
      const config = withConfiguredBinary(selected?.config ?? DEFAULT_CONFIG, settings.binaryPath);
      const optimizerRecommendation = benchmarks.find(result => result.autoTuneCandidate && result.suiteId === "context-stability-v1" && result.suiteSummary?.passed && result.meetsTargets && result.configSnapshot);
      set({ settings, profiles, benchmarks, benchmarkSuites, optimizerProgress: undefined, optimizerRecommendation, optimizerProfiles: [], optimizerCancelRequested: false, optimizerRunning: false, knownGoodProfile: knownGoodProfile ?? undefined, knownGoodRouter: knownGoodRouter ?? undefined, config, savedConfig: config, logs: bridge.isTauri() ? [] : MOCK_LOGS, initialized: true });
      await syncWindowsAutostart(settings.startWithWindows).catch(() => undefined);
      const initializationTasks = [get().rescanModels(), get().refreshRuntime()];
      if (settings.serverEngine === "llama_cpp") initializationTasks.push(get().detectBinary());
      await Promise.allSettled(initializationTasks);
      const hasSelectedModel = settings.serverEngine === "ollama" ? Boolean(settings.ollamaModel) : settings.serverEngine === "strata" ? Boolean(settings.strataConfigPath) : settings.serverEngine === "qwfnfer" ? Boolean(settings.qwfn.modelPath && settings.qwfn.binaryPath) : Boolean(config.modelPath);
      if (settings.setupCompleted && settings.autoStartServer && hasSelectedModel && get().runtime.state === "stopped") await get().start();
    } catch (e) { set({ initialized: true, error: String(e) }); }
  },
}));
