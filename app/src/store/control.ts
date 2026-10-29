import type { SettingsSection } from "../types/app";
import { create } from "zustand";
import i18n from "../lib/i18n";
import { detectAppLanguage } from "../lib/languages";
import { appendRuntimeHistory } from "../lib/history";
import { shouldCommitReadyLaunch } from "../lib/lastKnownGood";
import { withConfiguredBinary } from "../lib/profileConfig";
import { profileContextSize, strataRuntimeConfig } from "../lib/serverContext";
import { sameFilePath } from "../lib/filePaths";
import { validateConfig } from "../lib/validation";
import { DEFAULT_SETTINGS, type AppSettings, type AppView, type BenchmarkRequest, type BenchmarkResult, type BenchmarkProfileSelection, type BenchmarkProfileGoal, type BenchmarkSuiteDefinition, type BenchmarkTuningProgress, type LaunchProfile, type ModelInfo, type AppNotice, type LlamaDevice, type RouterRecoverySnapshot, type RouterSnapshotSettings, type ServerEngine, type ServerMode } from "../types/app";
import { DEFAULT_CAPABILITIES, DEFAULT_CONFIG, type LaunchConfig, type LlamaCapabilities } from "../types/config";
import type { RunInfo, RunLogEvent, RunStateEvent } from "../types/runtime";
import type { LogLine, RuntimeHistoryPoint, RuntimeSnapshot, ServerState } from "../types/runtime";
import { MOCK_LOGS, MOCK_RUNTIME } from "../mocks/runtime";
import * as bridge from "../services/tauri";
import { syncWindowsAutostart } from "../services/desktop";
import { buildEngineModels, supportsEngine, type EngineModel, ENGINE_NAMES } from "../lib/engineModels";
import { modelLaunchMetadata } from "../lib/models";
import type { StrataModelOption } from "../types/app";
import { buildBenchmarkCandidates, buildProfileSearchCandidates, rankProfileResults, MINIMUM_AGENT_CONTEXT, DEFAULT_SEARCH_CONTEXT } from "../lib/benchmarkOptimizer";
import { captureEngineOptions, isSupportedProfileEngine, profileRunId, restoreEngineOptions } from "../features/launches/profiles";
import { BenchmarkJobCancelledError, type JobInfo } from "../types/jobs";
import { extractBenchmarkLaunchConfig, mergeBenchmarkLaunchConfig } from "../lib/benchmarkLaunchConfig";
import { routerModelId } from "../lib/router";
import { createTaskProfile } from "../features/smartTasks/application";

let runtimeRefreshInFlight = false;
let initializationInFlight: Promise<void> | undefined;
const runRefreshInFlight = new Set<string>();
let routerSyncQueue: Promise<void> = Promise.resolve();

interface ManagedRunSession {
  remembered?: boolean;
  info: RunInfo;
  config: LaunchConfig;
  settings: AppSettings;
  runtime: RuntimeSnapshot;
  logs: LogLine[];
  history: RuntimeHistoryPoint[];
  profileRevision?: number;
  profilesSnapshot?: LaunchProfile[];
  readyGeneration?: number;
}
interface RunDraft { config: LaunchConfig; settings: AppSettings; dirty: boolean; }
const activeRunState = (state: ServerState) => !["stopped", "crashed"].includes(state);
const endpointParts = (endpoint: string, fallback: LaunchConfig) => {
  try {
    const url = new URL(endpoint);
    return { ...fallback, host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
  } catch { return fallback; }
};
const profileIdForRun = (runId: string) => runId.startsWith("profile:") ? runId.slice("profile:".length) : undefined;
const endpointForSettings = (config: LaunchConfig, settings: AppSettings) => {
  if (!settings.serverEngine) return "";
  if (settings.serverEngine === "strata") return `http://${settings.strataHost}:${settings.strataPort}`;
  return settings.serverMode === "router" ? `http://${settings.routerHost}:${settings.routerPort}` : `http://${config.host}:${config.port}`;
};
const RUN_SETTING_KEYS: (keyof AppSettings)[] = ["serverEngine", "serverMode", "binaryPath", "routerHost", "routerPort", "routerMaxLoadedModels", "routerAutoload", "routerApiKey", "legacyEngineId", "strataRootPath", "strataConfigPath", "strataHost", "strataPort", "strataApiKey"];
const mergeRunSettings = (base: AppSettings, source: AppSettings): AppSettings => {
  const merged = { ...base };
  for (const key of RUN_SETTING_KEYS) (merged as Record<string, unknown>)[key] = source[key];
  return merged;
};
const runSession = (info: RunInfo, profiles: LaunchProfile[], settings: AppSettings, fallback = DEFAULT_CONFIG): ManagedRunSession => {
  const profile = profiles.find(candidate => candidate.id === profileIdForRun(info.runId) || candidate.id === info.modelId);
  const baseConfig = profile?.config ?? { ...fallback, profileId: profileIdForRun(info.runId) ?? info.runId, profileName: info.name };
  const config = endpointParts(info.endpoint, { ...baseConfig, engine: info.engine, profileName: info.name, ctxSize: info.contextTokens });
  const runSettings = { ...(profile ? mergeRunSettings(settings, restoreEngineOptions(profile.config, settings)) : settings), serverEngine: info.engine, serverMode: info.mode };
  if (info.managed) {
    if (info.engine === "llama_cpp" && info.mode === "router") Object.assign(runSettings, { routerHost: config.host, routerPort: config.port });
    if (info.engine === "strata") Object.assign(runSettings, { strataHost: config.host, strataPort: config.port });
  }
  const runtime: RuntimeSnapshot = { ...INITIAL_RUNTIME, state: info.state, endpoint: info.endpoint, backend: info.engine, modelName: info.name, pid: info.pid, processStartedAt: info.startedAt, lastError: info.lastError, contextTotal: info.contextTokens };
  return { info, config: captureEngineOptions(config, runSettings), settings: runSettings, runtime, logs: [], history: [], profileRevision: profile?.revision, profilesSnapshot: structuredClone(profiles), readyGeneration: info.generation };
};
const runFacade = (session: ManagedRunSession, config: LaunchConfig, settings: AppSettings, dirty: boolean) => ({
  selectedRunId: session.info.runId,
  config,
  savedConfig: session.config,
  settings,
  dirty,
  runtime: session.runtime,
  logs: session.logs,
  history: session.history,
  runningConfig: activeRunState(session.info.state) ? session.config : undefined,
  runningMode: activeRunState(session.info.state) ? session.info.mode : undefined,
  runningEngine: activeRunState(session.info.state) ? session.info.engine : undefined,
  runningRouterSettings: activeRunState(session.info.state) && session.info.mode === "router" ? {
    binaryPath: settings.binaryPath, serverMode: "router" as const, routerHost: endpointParts(session.info.endpoint, DEFAULT_CONFIG).host,
    routerPort: endpointParts(session.info.endpoint, DEFAULT_CONFIG).port, routerMaxLoadedModels: settings.routerMaxLoadedModels,
    routerAutoload: settings.routerAutoload, routerApiKey: settings.routerApiKey,
  } : undefined,
});
const profileMatchesEngineModel = (profile: LaunchProfile, model: EngineModel, engine: ServerEngine) => {
  if ((profile.config.engine ?? "llama_cpp") !== engine) return false;
  if (profile.config.engineModel === model.name) return true;
  if (engine === "llama_cpp") return profile.config.modelPath === model.sources.llama_cpp?.path;
  if (engine === "strata") return profile.config.modelPath === model.sources.strata?.modelPath || profile.config.modelPath === model.sources.strata?.configPath;
  return false;
};

interface ControlState {
  benchmarkProgress?: import("../types/app").BenchmarkProgress;
  benchmarkEvents: (import("../types/app").BenchmarkProgress & { timestamp: number })[];
  settingsOpen:boolean;
  settingsSection:SettingsSection;
  activeView: AppView;
  config: LaunchConfig;
  savedConfig: LaunchConfig;
  capabilities: LlamaCapabilities;
  runtime: RuntimeSnapshot;
  runs: ManagedRunSession[];
  saveServer: (profileId:string)=>Promise<string>;
  pinRun: (runId: string, pinned: boolean) => Promise<void>;
  removeRun: (runId: string) => Promise<void>;
  selectedRunId?: string;
  runDrafts: Record<string, RunDraft>;
  runBusyById: Record<string, boolean>;
  runningConfig?: LaunchConfig;
  runningMode?: ServerMode;
  runningEngine?: ServerEngine;
  runningRouterSettings?: RouterSnapshotSettings;
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
  strataModels: StrataModelOption[];
  libraryErrors: string[];
  syncRouterProfiles: () => Promise<void>;
  selectLibraryModel: (id: string, engine: ServerEngine) => Promise<boolean>;
  devices: LlamaDevice[];
  availableEngines: ServerEngine[];
  refreshAvailableEngines: () => Promise<void>;
  benchmarks: BenchmarkResult[];
  benchmarkJob?: JobInfo;
  activeBenchmarkJobId?: string;
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
  applyTaskProfile: (sourceId: string, config: LaunchConfig, name: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  importProfile: (path: string) => Promise<void>;
  exportProfile: (id: string, path: string) => Promise<void>;
  selectProfile: (id: string) => Promise<void>;
  focusProfileRun: (id: string) => void;
  saveConfigLocal: () => void;
  setServerState: (state: ServerState) => void;
  start: (profileId?: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: (profileId?: string) => Promise<void>;
  rollback: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  loadRuns: () => Promise<void>;
  selectRun: (runId: string) => void;
  startManagedRun: (runId?: string) => Promise<void>;
  stopManagedRun: (runId: string) => Promise<void>;
  restartManagedRun: (runId: string) => Promise<void>;
  stopAllManagedRuns: () => Promise<void>;
  refreshManagedRuns: () => Promise<void>;
  appendRunLog: (event: RunLogEvent) => void;
  setManagedRunState: (event: RunStateEvent) => void;
  appendLog: (line: LogLine) => void;
  clearLogs: () => void;
  setLogFilter: (filter: ControlState["logFilter"]) => void;
  setLogSearch: (value: string) => void;
  detectBinary: (binaryPath?: string) => Promise<void>;
  rescanModels: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  runBenchmark: (request: BenchmarkRequest) => Promise<void>;
  cancelBenchmark: () => Promise<void>;
  runAutoTune: (request: BenchmarkRequest) => Promise<void>;
  cancelAutoTune: () => void;
  applyOptimizerRecommendation: () => void;
  dismissNotice: (id: string) => void;
  notify: (kind: AppNotice["kind"], message: string) => void;
  /** A toast with one action, e.g. "Undo"; it stays a little longer so the action can be reached. */
  notifyAction: (kind: AppNotice["kind"], message: string, action: NonNullable<AppNotice["action"]>, durationMs?: number) => void;
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
async function waitForManagedRunReady(runId: string) {
  let last = await bridge.getRunRuntime(runId);
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (["ready", "busy", "crashed"].includes(last.state) || (last.state === "stopped" && attempt >= 4)) return last;
    await delay(2000);
    last = await bridge.getRunRuntime(runId);
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
  gpu: { name: "", utilization: 0, memoryUsedMiB: 0, memoryTotalMiB: 0, temperatureC: 0, powerW: null, powerLimitW: null, clockMHz: 0 },
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
  ...existing,
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

/** Capabilities belong to the binary being launched, not the last opened editor. */
async function prepareManagedCapabilities(config: LaunchConfig, settings: AppSettings, fallback: LlamaCapabilities): Promise<LlamaCapabilities> {
  if (!bridge.isTauri() || settings.serverEngine !== "llama_cpp") return fallback;
  if (settings.serverMode === "single" && !config.modelPath.trim()) throw new Error(i18n.t("launches.blocked.model"));
  const detected = await bridge.detectLlama(settings.binaryPath.trim() || config.binaryPath);
  if (!detected.capabilities.rawHelp?.trim()) throw new Error("llama.cpp capability detection is missing.");
  return detected.capabilities;
}

export const useControlStore = create<ControlState>((set, get) => ({
  settingsOpen:false,
  settingsSection:"general",
  activeView: "dashboard",
  config: DEFAULT_CONFIG,
  savedConfig: DEFAULT_CONFIG,
  capabilities: DEFAULT_CAPABILITIES,
  runtime: INITIAL_RUNTIME,
  runs: [], selectedRunId: undefined, runDrafts: {}, runBusyById: {},
  runningConfig: undefined, runningMode: undefined, runningEngine: undefined, runningRouterSettings: undefined, launchPid: undefined, launchAttempt: 0, readyAttempt: 0,
  benchmarkEvents: [],
  history: [],
  logs: [],
  profiles: [], knownGoodProfile: undefined, knownGoodRouter: undefined, models: [], libraryModels: [], strataModels: [], libraryErrors: [], devices: [], availableEngines: bridge.isTauri() ? [] : ["llama_cpp", "strata"], benchmarks: [], benchmarkJob: undefined, activeBenchmarkJobId: undefined, benchmarkSuites: [], optimizerProgress: undefined, optimizerRecommendation: undefined, optimizerProfiles: [], optimizerCancelRequested: false, optimizerRunning: false, notices: [], settings: DEFAULT_SETTINGS,
  dirty: false, initialized: false, busy: false,
  logFilter: "ALL", logSearch: "",

  setView: activeView => activeView==='settings'?set({settingsOpen:true}):set({activeView}),
  dismissNotice: id => set(state => ({ notices: state.notices.filter(notice => notice.id !== id) })),
  notify: (kind, message) => set(state => ({ notices: withNotice(state.notices, makeNotice(kind, message)) })),
  notifyAction: (kind, message, action, durationMs = 6000) => set(state => ({ notices: withNotice(state.notices, { ...makeNotice(kind, message), action, durationMs }) })),
  clearError: () => set({ error: undefined }),
  updateConfig: (key, value) => {
    if (get().optimizerRunning) return;
    set(state => {
      const config = { ...state.config, [key]: value };
      const runDrafts = state.selectedRunId ? { ...state.runDrafts, [state.selectedRunId]: { config, settings: state.settings, dirty: true } } : state.runDrafts;
      return { config, runDrafts, dirty: true };
    });
  },
  replaceConfig: (config, saved = false) => {
    if (get().optimizerRunning) return;
    set(state => ({ config, savedConfig: saved ? config : state.savedConfig, dirty: !saved, ...(state.selectedRunId ? { runDrafts: { ...state.runDrafts, [state.selectedRunId]: { config, settings: state.settings, dirty: !saved } } } : {}) }));
  },
  saveConfigLocal: () => set(state => ({ savedConfig: state.config, dirty: false })),

  saveCurrentProfile: async () => {
    const state = get();
    if (state.optimizerRunning) return;
    const config = captureEngineOptions(structuredClone(state.config), state.settings);
    const existing = state.profiles.find(p => p.id === config.profileId);
    const saved = await bridge.saveProfile(makeProfile(config, existing));
    set(s => {
      const stillMatches = JSON.stringify(s.config) === JSON.stringify(state.config);
      return { profiles: [...s.profiles.filter(p => p.id !== saved.id), saved].sort((a,b)=>a.name.localeCompare(b.name)), ...(stillMatches ? { config, savedConfig: config, dirty: false, ...(s.selectedRunId ? { runDrafts: { ...s.runDrafts, [s.selectedRunId]: { config, settings: s.settings, dirty: false } } } : {}) } : {}), notices: withNotice(s.notices, makeNotice("success", i18n.t("notification.profileSaved"))) };
    });
    await get().syncRouterProfiles();
  },
  duplicateProfile: async name => {
    if (get().busy || get().optimizerRunning) return;
    const state = get();
    const base = captureEngineOptions(state.config, state.settings);
    const id = crypto.randomUUID();
    const config = { ...base, profileId: id, profileName: name || `${base.profileName} Copy` };
    const original = state.profiles.find(profile => profile.id === base.profileId);
    const cloned = bridge.isTauri() && original?.v2 ? await bridge.duplicateProfileSnapshot(original, id, config.profileName) : undefined;
    let saved: LaunchProfile;
    try {
      saved = await bridge.saveProfile({ ...makeProfile(config, cloned ?? original), revision: cloned?.revision, createdAt: now(), lastUsedAt: undefined, lastKnownGood: false });
    } catch (error) {
      if (cloned) {
        try { await bridge.deleteProfile(cloned.id, cloned.revision); }
        catch { set({ profiles: await bridge.listProfiles() }); }
      }
      throw error;
    }
    const current = get();
    const runDrafts = current.selectedRunId ? { ...current.runDrafts, [current.selectedRunId]: { config: current.config, settings: current.settings, dirty: current.dirty } } : current.runDrafts;
    set({ profiles: [...current.profiles, saved], config, savedConfig: config, dirty: false, selectedRunId: undefined, runDrafts });
    get().focusProfileRun(saved.id);
    await get().syncRouterProfiles();
  },
  applyTaskProfile: async (sourceId, config, name) => {
    const state = get();
    if (state.busy || state.optimizerRunning) throw new Error(i18n.t('smart.errors.busy'));
    const source = state.profiles.find(p => p.id === sourceId);
    if (!source) throw new Error(i18n.t('smart.errors.source'));
    set({ busy: true });
    try {
      const result = await createTaskProfile(source, config, state.settings, state.capabilities, name);
      set(s => ({ profiles: [...s.profiles, result.profile] }));
      // Preserve the user's selection if they navigated to another server while saving.
      if (get().selectedRunId === state.selectedRunId && get().config.profileId === state.config.profileId) {
        const current = get();
        const runDrafts = current.selectedRunId ? { ...current.runDrafts, [current.selectedRunId]: { config: current.config, settings: current.settings, dirty: current.dirty } } : current.runDrafts;
        set({ config: result.profile.config, savedConfig: result.profile.config, settings: result.settings, dirty: false, selectedRunId: undefined, runDrafts });
        get().focusProfileRun(result.profile.id);
      }
      // No router refresh: running servers retain their captured presets until an explicit restart.
    } finally { set({ busy: false }); }
  },
  deleteProfile: async id => {
    await bridge.deleteProfile(id, get().profiles.find(profile => profile.id === id)?.revision);
    const profiles = get().profiles.filter(p => p.id !== id);
    const next = profiles.find(profile => isSupportedProfileEngine(profile.config.engine ?? "llama_cpp"))?.config ?? DEFAULT_CONFIG;
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
      // Managed runs keep the preset captured at start; edits apply on restart.
      if (state.runs.some(run => run.info.runId === state.selectedRunId && run.info.managed)) return;
      try { await bridge.refreshRouterProfiles({ ...state.settings, ...state.runningRouterSettings }, state.profiles, state.capabilities, { runId: state.runs.some(run => run.info.runId === state.selectedRunId && run.info.managed) ? state.selectedRunId : undefined, profileId: state.runningConfig?.profileId }); }
      catch (error) { set({ error: `Router: ${String(error)}` }); throw error; }
    });
    routerSyncQueue = sync;
    await sync;
  },
  exportProfile: async (id, path) => { await bridge.exportProfile(id, path); set(state => ({ notices: withNotice(state.notices, makeNotice("success", i18n.t("notification.profileExported"))) })); },
  selectLibraryModel: async (id, engine) => {
    const state = get();
    if (state.optimizerRunning) return false;
    if (!state.availableEngines.includes(engine)) { set({ error: i18n.t("engines.none") }); return false; }
    const model = state.libraryModels.find(model => model.id === id);
    if (!model || !supportsEngine(model, engine)) { set({ error: i18n.t("models.engineUnsupported", { engine: ENGINE_NAMES[engine] }) }); return false; }
    const existing = state.profiles.find(profile => profileMatchesEngineModel(profile, model, engine));
    if (existing) {
      await get().selectProfile(existing.id);
      return true;
    }
    let nextConfig: LaunchConfig;
    let settingsPatch: Partial<AppSettings>;
    if (engine === "llama_cpp") {
      const source = model.sources.llama_cpp!;
      nextConfig = { ...DEFAULT_CONFIG, binaryPath: state.settings.binaryPath, engine, engineModel: undefined, profileId: crypto.randomUUID(), profileName: model.name, modelPath: source.path, modelBytes: source.sizeBytes, modelAlias: model.name, ...modelLaunchMetadata(source) };
      settingsPatch = { serverEngine: engine };
      if (!state.capabilities.rawHelp) await get().detectBinary();
    } else if (engine === "strata") {
      const source = model.sources.strata!;
      nextConfig = { ...DEFAULT_CONFIG, engine, engineModel: model.name, profileId: crypto.randomUUID(), profileName: model.name, modelPath: source.modelPath ?? source.configPath, modelAlias: source.modelName, ctxSize: source.contextLength };
      settingsPatch = { serverEngine: engine, strataConfigPath: source.configPath };
    } else throw new Error(i18n.t("models.engineUnsupported", { engine: String(engine) }));
    const previous = get();
    const runDrafts = previous.selectedRunId ? { ...previous.runDrafts, [previous.selectedRunId]: { config: previous.config, settings: previous.settings, dirty: previous.dirty } } : previous.runDrafts;
    set({ selectedRunId: undefined, runDrafts, config: structuredClone(nextConfig), savedConfig: DEFAULT_CONFIG, dirty: true });
    await get().updateSettings(settingsPatch);
    get().focusProfileRun(nextConfig.profileId);
    return true;
  },
  selectProfile: async id => {
    if (get().optimizerRunning) return;
    const profile = get().profiles.find(p => p.id === id);
    if (profile) {
      if (profile.unsupportedEngine) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: profile.unsupportedEngine }) }); return; }
      if (!isSupportedProfileEngine(profile.config.engine ?? "llama_cpp")) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: profile.config.engine }) }); return; }
      const currentSettings = get().settings;
      let settings = restoreEngineOptions(profile.config, currentSettings);
      const config = withConfiguredBinary(profile.config, settings.binaryPath);
      const engine = profile.config.engine ?? "llama_cpp";
      if (!isSupportedProfileEngine(engine)) { set({ error: i18n.t("profiles.unsupportedEngine", { engine }) }); return; }
      settings = { ...settings, serverEngine: engine, legacyEngineId: null };
      set(state => ({ config: structuredClone(config), savedConfig: structuredClone(config), settings, dirty: false, selectedRunId: undefined, ...(state.selectedRunId ? { runDrafts: { ...state.runDrafts, [state.selectedRunId]: { config: state.config, settings: state.settings, dirty: state.dirty } } } : {}) }));
      await bridge.saveSettings(settings);
      get().focusProfileRun(profile.id);
    }
  },
  focusProfileRun: id => {
    const state = get();
    // Preserve the old single-server compatibility facade while a legacy launch is active.
    if (!state.runs.some(run => run.info.managed) && state.runningEngine) return;
    const runId = profileRunId(id);
    const profile = state.profiles.find(candidate => candidate.id === id);
    const config = profile?.config ?? (state.config.profileId === id ? state.config : undefined);
    if (!config) return;
    if (!isSupportedProfileEngine(config.engine ?? "llama_cpp")) return;
    const session = state.runs.find(candidate => candidate.info.runId === runId);
    if (!session) {
      // A selected profile is an editor draft, not a stopped server. Only startManagedRun
      // may add a new session, after the native launch has actually been requested.
      set({ selectedRunId: undefined, runningConfig: undefined, runningEngine: undefined, runningMode: undefined,
        runningRouterSettings: undefined, logs: [], history: [],
        runtime: { ...INITIAL_RUNTIME, state: "stopped", uptimeSeconds: 0, modelName: undefined, pid: undefined, processStartedAt: undefined, lastError: undefined,
          generationTps: 0, promptTps: 0, ttftMs: null, contextUsed: 0, contextTotal: 0, activeRequests: 0, queuedRequests: 0,
          slots: [], metricsAvailable: false, slotsAvailable: false, healthStatus: 0,
          gpu: state.runtime.gpu, cpu: state.runtime.cpu, memory: state.runtime.memory,
          endpoint: endpointForSettings(state.config, state.settings), backend: state.settings.serverEngine } });
      return;
    }
    const runDrafts = state.selectedRunId ? { ...state.runDrafts, [state.selectedRunId]: { config: state.config, settings: state.settings, dirty: state.dirty } } : state.runDrafts;
    const draft = runDrafts[runId] ?? { config: session.config, settings: session.settings, dirty: false };
    const settings = mergeRunSettings(state.settings, draft.settings);
    set({ runDrafts: { ...runDrafts, [runId]: draft }, ...runFacade(session, draft.config, settings, draft.dirty) });
  },

  loadRuns: async () => {
    if (typeof bridge.listRuns !== "function") return;
    try {
      const infos = await bridge.listRuns();
      const state = get();
      const runs = infos.map(info => {
        const existing = state.runs.find(run => run.info.runId === info.runId);
        return existing ? { ...existing, info, remembered: false } : runSession(info, state.profiles, state.settings, state.config);
      });
      const returnedIds = new Set(infos.map(info => info.runId));
      for (const runId of state.settings.pinnedServerIds ?? []) {
        if(returnedIds.has(runId))continue;
        const profile=state.profiles.find(profile=>profile.id===profileIdForRun(runId));
        if(!profile||!isSupportedProfileEngine(profile.config.engine??'llama_cpp'))continue;
        const settings=restoreEngineOptions(profile.config,state.settings);
        const engine = profile.config.engine ?? 'llama_cpp';
        if (!isSupportedProfileEngine(engine)) continue;
        const info:RunInfo={runId,name:profile.name,engine,mode:engine==='llama_cpp'?settings.serverMode:'single',modelId:profile.id,
          endpoint:endpointForSettings(profile.config,settings),contextTokens:profileContextSize(profile.config,state.strataModels),state:'stopped',generation:0,managed:true};
        runs.push({...runSession(info,state.profiles,state.settings),remembered:true});
      }
      runs.push(...state.runs.filter(run => !run.info.managed && run.info.generation > 0 && !returnedIds.has(run.info.runId)));
      const selected = state.selectedRunId && runs.some(run => run.info.runId === state.selectedRunId) ? state.selectedRunId : runs[0]?.info.runId;
      const runDrafts = state.selectedRunId ? { ...state.runDrafts, [state.selectedRunId]: { config: state.config, settings: state.settings, dirty: state.dirty } } : state.runDrafts;
      set({ runs, runDrafts, selectedRunId: undefined });
      if (selected) get().selectRun(selected);
      if (infos.length) await get().refreshManagedRuns();
    } catch (error) {
      // A backend being upgraded without the run manager still uses the legacy facade.
      set({ error: String(error) });
    }
  },
  saveServer: async profileId=>{
    const state=get(),profile=state.profiles.find(p=>p.id===profileId);if(!profile)throw new Error('profile-missing');
    const runId=profileRunId(profileId);
    if(!state.runs.some(r=>r.info.runId===runId)){
      const settings=restoreEngineOptions(profile.config,state.settings);
      const engine = profile.config.engine ?? 'llama_cpp';
      if (!isSupportedProfileEngine(engine)) throw new Error(i18n.t("profiles.unsupportedEngine", { engine }));
      const info:RunInfo={runId,name:profile.name,engine,mode:engine==='llama_cpp'?settings.serverMode:'single',modelId:profile.id,endpoint:endpointForSettings(profile.config,settings),contextTokens:profileContextSize(profile.config,state.strataModels),state:'stopped',generation:0,managed:true};
      set(s=>({runs:[...s.runs,{...runSession(info,s.profiles,s.settings),remembered:true}]}));
    }
    await get().pinRun(runId,true);return runId;
  },
  pinRun: async (runId,pinned) => {
    const state=get();
    if(!state.runs.some(run=>run.info.runId===runId)||!state.profiles.some(profile=>profile.id===profileIdForRun(runId)))return;
    const ids=state.settings.pinnedServerIds??[];
    await get().updateSettings({pinnedServerIds:pinned?[...new Set([...ids,runId])]:ids.filter(id=>id!==runId)});
  },
  removeRun: async runId => {
    const state=get(),session=state.runs.find(run=>run.info.runId===runId);
    if(!session||activeRunState(session.info.state)||state.runBusyById[runId]||state.optimizerRunning)return;
    set(state=>({runBusyById:{...state.runBusyById,[runId]:true}}));
    try {
      if(!session.remembered)await bridge.removeRun(runId);
      if((get().settings.pinnedServerIds??[]).includes(runId))await get().updateSettings({pinnedServerIds:get().settings.pinnedServerIds.filter(id=>id!==runId)});
      set(current=>({runs:current.runs.filter(run=>run.info.runId!==runId),
        ...(current.selectedRunId===runId?{selectedRunId:undefined,runningConfig:undefined,runningEngine:undefined,runningMode:undefined,runningRouterSettings:undefined,logs:[],history:[],
          runtime:{...INITIAL_RUNTIME,gpu:current.runtime.gpu,cpu:current.runtime.cpu,memory:current.runtime.memory,state:'stopped',endpoint:endpointForSettings(current.config,current.settings),backend:current.settings.serverEngine}}:{})}));
    } catch(error){set({error:String(error)});}
    finally{set(current=>({runBusyById:{...current.runBusyById,[runId]:false}}));}
  },
  selectRun: runId => {
    const state = get();
    if (state.selectedRunId === runId) return;
    const session = state.runs.find(run => run.info.runId === runId);
    if (!session) return;
    const runDrafts = state.selectedRunId ? { ...state.runDrafts, [state.selectedRunId]: { config: state.config, settings: state.settings, dirty: state.dirty } } : state.runDrafts;
    const draft = runDrafts[runId] ?? { config: session.config, settings: session.settings, dirty: false };
    const settings = mergeRunSettings(state.settings, draft.settings);
    set({ runDrafts: { ...runDrafts, [runId]: draft }, ...runFacade(session, draft.config, settings, draft.dirty) });
  },
  startManagedRun: async requestedRunId => {
    const initial = get();
    if (initial.optimizerRunning) return;
    const runId = requestedRunId ?? profileRunId(initial.config.profileId);
    if (initial.runBusyById[runId]) return;
    const session = initial.runs.find(run => run.info.runId === runId);
    if (session && activeRunState(session.info.state)) { get().selectRun(runId); return; }
    const draft = runId === initial.selectedRunId
      ? { config: initial.config, settings: initial.settings, dirty: initial.dirty }
      : initial.runDrafts[runId] ?? (session ? { config: session.config, settings: session.settings, dirty: false } : undefined);
    const config = draft?.config ?? (initial.config.profileId === profileIdForRun(runId) ? initial.config : undefined);
    if (!config) { set({ error: i18n.t("error.profileUnavailable") }); return; }
    const unsupportedEngine = initial.profiles.find(profile => profile.id === config.profileId)?.unsupportedEngine;
    if (unsupportedEngine) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: unsupportedEngine }) }); return; }
    if (!isSupportedProfileEngine(config.engine ?? "llama_cpp")) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: config.engine }) }); return; }
    const draftSettings = draft?.settings ?? initial.settings;
    const settings = (config.engine ?? "llama_cpp") === draftSettings.serverEngine ? draftSettings : restoreEngineOptions(config, draftSettings);
    if (!settings.serverEngine) { set({ error: i18n.t("launches.blocked.engineSelection") }); return; }
    if (settings.serverEngine === "strata" && !settings.strataConfigPath.trim()) { set({ error: i18n.t("error.strataConfigRequired") }); return; }
    set(state => ({ runBusyById: { ...state.runBusyById, [runId]: true }, error: undefined }));
    try {
      const capabilities = await prepareManagedCapabilities(config, settings, initial.capabilities);
      const profileConfig = captureEngineOptions({ ...withConfiguredBinary(structuredClone(config), settings.binaryPath), ctxSize: profileContextSize(config, initial.strataModels) }, settings);
      const existingProfile = get().profiles.find(profile => profile.id === profileConfig.profileId);
      let savedProfile = existingProfile;
      // An assigned runtime port is not an edit to the profile's preferred port.
      const unchangedRun = session?.info.managed && !draft?.dirty && JSON.stringify(profileConfig) === JSON.stringify(session.config);
      if (!existingProfile || (!unchangedRun && (JSON.stringify(existingProfile.config) !== JSON.stringify(profileConfig) || draft?.dirty))) {
        savedProfile = await bridge.saveProfile(makeProfile(profileConfig, existingProfile));
      }
      const profiles = savedProfile
        ? [...get().profiles.filter(profile => profile.id !== savedProfile!.id), savedProfile].sort((a, b) => a.name.localeCompare(b.name))
        : get().profiles;
      const request = await bridge.createRunStartRequest({ runId, config: profileConfig, settings, profiles, capabilities });
      const info = await bridge.startRun(request);
      const next = runSession(info, profiles, settings, profileConfig);
      next.readyGeneration = undefined;
      const state = get();
      const runDrafts = { ...state.runDrafts };
      delete runDrafts[runId];
      if (state.selectedRunId && state.selectedRunId !== runId) runDrafts[state.selectedRunId] = { config: state.config, settings: state.settings, dirty: state.dirty };
      set({ profiles, runs: [...state.runs.filter(run => run.info.runId !== runId), next], runDrafts, selectedRunId: undefined });
      get().selectRun(runId);
      void get().syncRouterProfiles().catch(() => undefined);
      await get().refreshManagedRuns();
    } catch (error) {
      set(state => ({
        error: String(error),
        runs: state.runs.map(run => run.info.runId === runId ? { ...run, info: { ...run.info, state: "crashed", lastError: String(error) }, runtime: { ...run.runtime, state: "crashed", lastError: String(error) } } : run),
      }));
    } finally {
      set(state => ({ runBusyById: { ...state.runBusyById, [runId]: false } }));
    }
  },
  stopManagedRun: async runId => {
    const initial = get();
    const session = initial.runs.find(run => run.info.runId === runId);
    if (!session || !activeRunState(session.info.state) || initial.runBusyById[runId]) return;
    set(state => ({
      runBusyById: { ...state.runBusyById, [runId]: true },
      runs: state.runs.map(run => run.info.runId === runId ? { ...run, info: { ...run.info, state: "stopping" }, runtime: { ...run.runtime, state: "stopping" } } : run),
      ...(state.selectedRunId === runId ? { runtime: { ...state.runtime, state: "stopping" } } : {}),
    }));
    try {
      await bridge.stopRun(runId);
      set(state => ({
        runs: state.runs.map(run => run.info.runId === runId ? { ...run, info: { ...run.info, state: "stopped", pid: undefined }, runtime: { ...run.runtime, state: "stopped", pid: undefined } } : run),
        ...(state.selectedRunId === runId ? { runtime: { ...state.runtime, state: "stopped", pid: undefined }, runningConfig: undefined, runningMode: undefined, runningEngine: undefined, runningRouterSettings: undefined } : {}),
      }));
    } catch (error) {
      set(state => ({ error: String(error), runs: state.runs.map(run => run.info.runId === runId ? { ...run, info: { ...run.info, state: "crashed", lastError: String(error) }, runtime: { ...run.runtime, state: "crashed", lastError: String(error) } } : run) }));
    } finally { set(state => ({ runBusyById: { ...state.runBusyById, [runId]: false } })); }
  },
  restartManagedRun: async runId => {
    const initial = get();
    const session = initial.runs.find(run => run.info.runId === runId);
    if (!session || initial.runBusyById[runId]) return;
    if (!activeRunState(session.info.state)) { await get().startManagedRun(runId); return; }
    const draft = runId === initial.selectedRunId
      ? { config: initial.config, settings: initial.settings, dirty: initial.dirty }
      : initial.runDrafts[runId] ?? { config: session.config, settings: session.settings, dirty: false };
    const config = captureEngineOptions(withConfiguredBinary(structuredClone(draft.config), draft.settings.binaryPath), draft.settings);
    const changed = draft.dirty || JSON.stringify(config) !== JSON.stringify(session.config) || JSON.stringify(draft.settings.serverEngine) !== JSON.stringify(session.info.engine);
    set(state => ({ runBusyById: { ...state.runBusyById, [runId]: true }, error: undefined }));
    try {
      let info: RunInfo;
      let profiles = get().profiles;
      if (changed) {
        // Validate the new binary before stopping the currently working server.
        const capabilities = await prepareManagedCapabilities(config, draft.settings, initial.capabilities);
        await bridge.stopRun(runId);
        const existing = profiles.find(profile => profile.id === config.profileId);
        const saved = await bridge.saveProfile(makeProfile(config, existing));
        profiles = [...profiles.filter(profile => profile.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
        const request = await bridge.createRunStartRequest({ runId, config, settings: draft.settings, profiles, capabilities });
        info = await bridge.startRun(request);
      } else {
        info = await bridge.restartRun(runId);
      }
      const next = runSession(info, profiles, draft.settings, config);
      next.readyGeneration = undefined;
      if (!changed) {
        next.profileRevision = session.profileRevision;
        next.profilesSnapshot = session.profilesSnapshot;
      }
      const state = get();
      const runDrafts = { ...state.runDrafts };
      delete runDrafts[runId];
      set({ profiles, runs: state.runs.map(run => run.info.runId === runId ? next : run), runDrafts, selectedRunId: undefined });
      get().selectRun(runId);
      await get().refreshManagedRuns();
    } catch (error) { set({ error: String(error) }); }
    finally { set(state => ({ runBusyById: { ...state.runBusyById, [runId]: false } })); }
  },
  stopAllManagedRuns: async () => {
    const state = get();
    const targets = state.runs.filter(run => run.info.managed && activeRunState(run.info.state));
    if (!targets.length) return;
    set(current => ({ runBusyById: { ...current.runBusyById, ...Object.fromEntries(targets.map(run => [run.info.runId, true])) } }));
    try {
      await bridge.stopAllRuns();
      set(current => ({
        runs: current.runs.map(run => targets.some(target => target.info.runId === run.info.runId) ? { ...run, info: { ...run.info, state: "stopped", pid: undefined }, runtime: { ...run.runtime, state: "stopped", pid: undefined } } : run),
        ...(current.selectedRunId && targets.some(target => target.info.runId === current.selectedRunId) ? { runtime: { ...current.runtime, state: "stopped", pid: undefined }, runningConfig: undefined, runningMode: undefined, runningEngine: undefined, runningRouterSettings: undefined } : {}),
      }));
    } catch (error) { set({ error: String(error) }); }
    finally { set(current => ({ runBusyById: { ...current.runBusyById, ...Object.fromEntries(targets.map(run => [run.info.runId, false])) } })); }
  },
  refreshManagedRuns: async () => {
    const sessions = get().runs.filter(run => run.info.managed && !run.remembered && runRefreshInFlight.has(run.info.runId) === false);
    await Promise.all(sessions.map(async session => {
      const runId = session.info.runId;
      const generation = session.info.generation;
      runRefreshInFlight.add(runId);
      try {
        const runtime = await bridge.getRunRuntime(runId);
        const current = get().runs.find(run => run.info.runId === runId);
        if (!current || current.info.generation !== generation) return;
        const history = appendRuntimeHistory(current.history, runtime);
        const updated = { ...current, runtime, history, info: { ...current.info, state: runtime.state, pid: runtime.pid ?? current.info.pid, lastError: runtime.lastError ?? current.info.lastError } };
        set(state => ({
          runs: state.runs.map(run => run.info.runId === runId ? updated : run),
          ...(state.selectedRunId === runId ? {
            runtime,
            history,
            runningConfig: activeRunState(updated.info.state) ? updated.config : undefined,
            runningMode: activeRunState(updated.info.state) ? updated.info.mode : undefined,
            runningEngine: activeRunState(updated.info.state) ? updated.info.engine : undefined,
          } : {}),
        }));
        if (runtime.state === "ready" && updated.readyGeneration !== generation && updated.profileRevision !== undefined && !runId.startsWith("trial:")) {
          set(state => ({ runs: state.runs.map(run => run.info.runId === runId && run.info.generation === generation ? { ...run, readyGeneration: generation } : run) }));
          if (updated.info.mode === "router") {
            const snapshot: RouterRecoverySnapshot = { profiles: structuredClone((updated.profilesSnapshot ?? []).filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp")), config: structuredClone(updated.config), settings: routerSnapshotSettings(updated.settings) };
            await bridge.markRouterGood(snapshot);
            const knownGoodRouter = await bridge.loadLastKnownGoodRouter();
            if (get().runs.some(run => run.info.runId === runId && run.info.generation === generation)) set({ knownGoodRouter: knownGoodRouter ?? undefined });
          } else {
            await bridge.markProfileGood(updated.config.profileId, updated.profileRevision);
            const knownGoodProfile = await bridge.loadLastKnownGood();
            if (get().runs.some(run => run.info.runId === runId && run.info.generation === generation)) set({ knownGoodProfile: knownGoodProfile ?? undefined });
          }
          const profiles = await bridge.listProfiles();
          if (get().runs.some(run => run.info.runId === runId && run.info.generation === generation)) set({ profiles });
        }
      } catch (error) {
        const current = get().runs.find(run => run.info.runId === runId);
        // A poll started before stop/restart can fail after the operation completes.
        // Its error must not replace the new lifecycle state with a stale alert.
        if (current?.info.generation === generation && activeRunState(current.info.state)
          && !get().runBusyById[runId] && get().selectedRunId === runId) set({ error: String(error) });
      } finally { runRefreshInFlight.delete(runId); }
    }));
  },
  appendRunLog: event => set(state => {
    const session = state.runs.find(run => run.info.runId === event.runId);
    if (!session || session.info.generation !== event.generation) return {};
    const logs = [...session.logs.slice(-(state.settings.logRetentionLines - 1)), event.line];
    const updated = { ...session, logs };
    return { runs: state.runs.map(run => run.info.runId === event.runId ? updated : run), ...(state.selectedRunId === event.runId ? { logs } : {}) };
  }),
  setManagedRunState: event => set(state => {
    const session = state.runs.find(run => run.info.runId === event.runId);
    if (!session || session.info.generation !== event.generation) return {};
    const updated = { ...session, info: { ...session.info, state: event.state }, runtime: { ...session.runtime, state: event.state } };
    return { runs: state.runs.map(run => run.info.runId === event.runId ? updated : run), ...(state.selectedRunId === event.runId ? { runtime: updated.runtime } : {}) };
  }),
  setServerState: state => set(s => s.selectedRunId && s.runs.find(run => run.info.runId === s.selectedRunId)?.info.managed ? {} : s.runtime.state === "stopping" ? {} : ({ runtime: { ...s.runtime, state } })),
  start: async (profileId) => {
    const initial = get();
    const requested = profileId ? initial.profiles.find(profile => profile.id === profileId) : undefined;
    if (requested?.unsupportedEngine) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: requested.unsupportedEngine }) }); return; }
    if (requested && !isSupportedProfileEngine(requested.config.engine ?? "llama_cpp")) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: requested.config.engine }) }); return; }
    if (initial.selectedRunId) {
      if (profileId) await get().selectProfile(profileId);
      await get().startManagedRun(get().selectedRunId);
      return;
    }
    if (initial.busy || initial.optimizerRunning) return;
    if (!initial.settings.serverEngine) { set({ error: i18n.t("launches.blocked.engineSelection") }); return; }
    if (initial.settings.serverEngine === "strata") {
      if (!initial.settings.strataConfigPath.trim()) { set({ error: i18n.t("error.strataConfigRequired") }); return; }
      const launchConfig = strataRuntimeConfig(initial.config, initial.settings, initial.strataModels);
      set(s => ({ busy: true, error: undefined, runningConfig: launchConfig, runningMode: "single", runningEngine: "strata", runningRouterSettings: undefined, launchPid: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "starting" } }));
      const attempt = get().launchAttempt;
      try {
        const { pid } = await bridge.startStrataServer(initial.settings);
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
    if (state.selectedRunId) {
      if (state.selectedRunId) await get().stopManagedRun(state.selectedRunId);
      return;
    }
    if (state.busy || state.optimizerRunning || state.runtime.state === "stopping") return;
    // Invalidate telemetry already in flight before changing the lifecycle state.
    set(s => ({ busy: true, error: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, state: "stopping" } }));
    const finishStop = () => set(s => ({
      runningConfig: undefined, runningMode: undefined, runningEngine: undefined,
      runningRouterSettings: undefined, launchPid: undefined,
      runtime: { ...s.runtime, state: "stopped", uptimeSeconds: 0, pid: undefined, processStartedAt: undefined,
        modelName: undefined, lastError: undefined, generationTps: 0, promptTps: 0, generationMeanTps: undefined,
        generationWindowSeconds: undefined, activeRequests: 0, queuedRequests: 0, ttftMs: null,
        contextUsed: 0, contextTotal: 0, slots: [], metricsAvailable: false, slotsAvailable: false, healthStatus: 0 },
      notices: withNotice(s.notices, makeNotice("info", i18n.t("notification.serverStopped"))),
    }));
    try { await bridge.stopServer(); finishStop(); }
    catch (e) { set(s => ({ error: String(e), runtime: { ...s.runtime, state: state.runtime.state } })); }
    finally { set({ busy: false }); }
  },
  restart: async (profileId) => {
    const state = get();
    const requested = profileId ? state.profiles.find(profile => profile.id === profileId) : undefined;
    if (requested?.unsupportedEngine) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: requested.unsupportedEngine }) }); return; }
    if (requested && !isSupportedProfileEngine(requested.config.engine ?? "llama_cpp")) { set({ error: i18n.t("profiles.unsupportedEngine", { engine: requested.config.engine }) }); return; }
    if (state.selectedRunId) {
      if (profileId) await get().selectProfile(profileId);
      const target = get().selectedRunId;
      if (target) await get().restartManagedRun(target);
      else await get().startManagedRun();
      return;
    }
    if (state.busy || state.optimizerRunning) return;
    if (!state.settings.serverEngine) { set({ error: i18n.t("launches.blocked.engineSelection") }); return; }
    if (state.settings.serverEngine === "strata") {
      if (!state.settings.strataConfigPath.trim()) { set({ error: i18n.t("error.strataConfigRequired") }); return; }
      const launchConfig = strataRuntimeConfig(state.config, state.settings, state.strataModels);
      set(s => ({ busy: true, error: undefined, runningConfig: launchConfig, runningMode: "single", runningEngine: "strata", runningRouterSettings: undefined, launchPid: undefined, launchAttempt: s.launchAttempt + 1, runtime: { ...s.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "restarting" } }));
      const attempt = get().launchAttempt;
      try {
        const { pid } = await bridge.restartStrataServer(state.settings);
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
    if (bridge.isTauri()) {
      const initial = get();
      if (initial.optimizerRunning || initial.busy) return;
      try {
        const router = (initial.runningMode ?? initial.settings.serverMode) === "router" && (initial.runningEngine ?? initial.settings.serverEngine) === "llama_cpp";
        const knownRouter = router ? await bridge.loadLastKnownGoodRouter() : null;
        const knownProfile = router ? knownRouter?.profiles.find(profile => profile.id === knownRouter.config.profileId) ?? knownRouter?.profiles[0] : await bridge.loadLastKnownGood();
        if (!knownProfile) return;
        if (!isSupportedProfileEngine(knownProfile.config.engine ?? "llama_cpp")) throw new Error(i18n.t("profiles.unsupportedEngine", { engine: knownProfile.config.engine }));
        const targetId = profileRunId(knownProfile.id);
        const target = get().runs.find(run => run.info.runId === targetId);
        if (target && activeRunState(target.info.state)) {
          await get().stopManagedRun(targetId);
          if (get().runs.find(run => run.info.runId === targetId)?.info.state !== "stopped") return;
        } else if (!get().selectedRunId && activeRunState(get().runtime.state)) {
          await get().stop();
          if (activeRunState(get().runtime.state)) return;
        }
        const restoredRouter = router ? await bridge.restoreLastKnownGoodRouter() : undefined;
        const restored = restoredRouter?.profiles.find(profile => profile.id === restoredRouter.config.profileId) ?? restoredRouter?.profiles[0] ?? await bridge.restoreLastKnownGoodProfile();
        const profiles = await bridge.listProfiles();
        const runDrafts = { ...get().runDrafts };
        delete runDrafts[targetId];
        set(state => ({ profiles, runs: state.runs.filter(run => run.info.runId !== targetId), runDrafts, selectedRunId: state.selectedRunId === targetId ? undefined : state.selectedRunId, ...(restoredRouter ? { settings: { ...state.settings, ...restoredRouter.settings }, knownGoodRouter: restoredRouter } : { knownGoodProfile: restored }) }));
        await get().selectProfile(restored.id);
        await get().startManagedRun(profileRunId(restored.id));
      } catch (error) { set({ error: String(error) }); }
      return;
    }
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
    if (get().runs.some(run => run.info.managed)) {
      await get().refreshManagedRuns();
      return;
    }
    if (runtimeRefreshInFlight || get().runtime.state === "stopping") return;
    runtimeRefreshInFlight = true;
    const state = get();
    const isCurrent = () => get().launchAttempt === state.launchAttempt && get().runtime.state !== "stopping";
    try {
      const engine = state.runningEngine ?? state.settings.serverEngine;
      if (!engine) {
        if (isCurrent()) set({ runtime: { ...INITIAL_RUNTIME, gpu: state.runtime.gpu, cpu: state.runtime.cpu, memory: state.runtime.memory, endpoint: "", backend: "" }, runningConfig: undefined, runningEngine: undefined, runningMode: undefined });
        return;
      }
      const observedConfig = state.runningConfig ?? (engine === "strata"
        ? strataRuntimeConfig(state.config, state.settings, state.strataModels)
        : state.settings.serverMode === "router" ? routerRuntimeConfig(state.config, state.settings) : state.config);
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
      if (shouldCommitReadyLaunch(runtime.state, runtime.pid, refreshed.launchPid, refreshed.launchAttempt, refreshed.readyAttempt) && refreshed.runningEngine === "strata") {
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
        await bridge.markProfileGood(config.profileId, saved.revision);
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
  appendLog: line => set(state => state.selectedRunId && state.runs.some(run => run.info.runId === state.selectedRunId && run.info.managed) ? {} : ({ logs: [...state.logs.slice(-(state.settings.logRetentionLines - 1)), line] })),
  clearLogs: () => set(state => {
    if (!state.selectedRunId) return { logs: [] };
    const runs = state.runs.map(run => run.info.runId === state.selectedRunId ? { ...run, logs: [] } : run);
    return { runs, logs: [] };
  }),
  setLogFilter: logFilter => set({ logFilter }),
  setLogSearch: logSearch => set({ logSearch }),

  refreshAvailableEngines: async () => {
    const settings = get().settings;
    const installations = await bridge.availableEngines(settings);
    set({ availableEngines: installations.map(item => item.id).filter(isSupportedProfileEngine) });
  },
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
      if (bridge.isTauri()) await get().refreshAvailableEngines();
      const settings = get().settings;
      const [modelResult, strataResult] = await Promise.allSettled([
        bridge.scanModels([...new Set([...settings.modelDirectories, ...get().profiles.filter(profile => !profile.config.engine || profile.config.engine === "llama_cpp").map(profile => profile.config.modelPath.replace(/[\\/][^\\/]+$/, "")).filter(Boolean)])]),
        settings.strataRootPath ? bridge.discoverStrataModels(settings.strataRootPath) : Promise.resolve([]),
      ]);
      const models = modelResult.status === "fulfilled" ? modelResult.value : [];
      const strataModels = strataResult.status === "fulfilled" ? strataResult.value : [];
      const libraryErrors = [
        ...(modelResult.status === "rejected" ? [`llama.cpp: ${String(modelResult.reason)}`] : []),
        ...(strataResult.status === "rejected" ? [`Strata: ${String(strataResult.reason)}`] : []),
      ];
      set({ models, strataModels, libraryModels: buildEngineModels(models, strataModels), libraryErrors });
    }
    catch (e) { set({ error: String(e) }); }
    finally { set({ busy: false }); }
  },
  updateSettings: async patch => {
    if (get().optimizerRunning) throw new Error(i18n.t("benchmark.tuningStarting"));
    const next = { ...get().settings, ...patch };
    if (patch.serverEngine) next.legacyEngineId = null;
    const saved = await bridge.saveSettings(next);
    await i18n.changeLanguage(saved.language);
    if (patch.startWithWindows !== undefined) await syncWindowsAutostart(saved.startWithWindows);
    set(state => {
      const hasRunSettings = RUN_SETTING_KEYS.some(key => Object.prototype.hasOwnProperty.call(patch, key));
      const config = patch.binaryPath ? { ...state.config, binaryPath: saved.binaryPath } : patch.serverEngine ? { ...state.config, engine: saved.serverEngine } : state.config;
      const runConfig = hasRunSettings ? captureEngineOptions(config, saved) : config;
      const runDrafts = state.selectedRunId && hasRunSettings
        ? { ...state.runDrafts, [state.selectedRunId]: { config: runConfig, settings: saved, dirty: true } }
        : state.runDrafts;
      return {
        settings: saved,
        notices: withNotice(state.notices, makeNotice("success", i18n.t("notification.settingsSaved"))),
        ...(config !== state.config ? { config, dirty: true } : {}),
        runDrafts,
      };
    });
    if (bridge.isTauri() && ["binaryPath", "strataRootPath"].some(key => key in patch)) await get().refreshAvailableEngines();
  },
  runBenchmark: async request => {
    if (request.autoSelectProfiles) { await get().runAutoTune(request); return; }
    if (get().runs.filter(run => run.info.managed && activeRunState(run.info.state)).length > 1) {
      set({ error: i18n.t("benchmark.concurrentRunsUnavailable") });
      return;
    }
    set({ busy: true, error: undefined, benchmarkJob: undefined, activeBenchmarkJobId: undefined, benchmarkProgress: undefined });
    try {
      const state = get();
      const config = state.runningConfig;
      const managedRun = state.runs.find(run => run.info.runId === state.selectedRunId && run.info.managed && activeRunState(run.info.state));
      const jobRunner = typeof bridge.runBenchmarkJob === "function" ? bridge.runBenchmarkJob : undefined;
      const runJob = async (benchmarkRequest: BenchmarkRequest) => {
        if (!managedRun || !jobRunner) return undefined;
        return jobRunner(managedRun.info.runId, benchmarkRequest, {
          onStarted: job => {
            set(state => ({ benchmarkJob: job, activeBenchmarkJobId: job.jobId, benchmarkProgress: { ...state.benchmarkProgress, phase: "prepare" } }));
            if (get().optimizerCancelRequested && typeof bridge.cancelJob === "function") void bridge.cancelJob(job.jobId).catch(error => set({ error: benchmarkErrorMessage(error) }));
          },
          onState: job => {
            if (job.runId !== managedRun.info.runId || job.generation !== managedRun.info.generation) return;
            set(current => ({
              benchmarkJob: job,
              activeBenchmarkJobId: ["completed", "cancelled", "failed", "interrupted"].includes(job.status) ? undefined : job.jobId,
              ...(job.status === "cancelled" ? { benchmarkProgress: undefined }
                : job.status === "completed" ? { benchmarkProgress: { ...current.benchmarkProgress, phase: "completed" as const } }
                  : ["failed", "interrupted"].includes(job.status) ? { benchmarkProgress: { ...current.benchmarkProgress, phase: "failed" as const } } : {}),
            }));
          },
          onProgress: event => {
            if (event.runId !== managedRun.info.runId || event.generation !== managedRun.info.generation) return;
            set(current => ({
              benchmarkProgress: { ...current.benchmarkProgress, ...event.progress },
              benchmarkEvents: [...current.benchmarkEvents.slice(-19), { ...event.progress, timestamp: Date.now() }],
            }));
          },
        });
      };
      const strataMode = state.runningEngine === "strata";
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
      const model = strataMode ? modelName : routerMode && profile ? routerModelId(profile, managedRun?.profilesSnapshot ?? state.profiles) : usesChatSuite ? config.modelAlias?.trim() || config.profileName : request.model;
      const benchmarkRequest = { ...request, profileId, ...(model ? { model } : {}), configSnapshot: strataMode ? config : profile?.config ?? config };
      const profileName = strataMode ? modelName : profile?.name ?? config.profileName;
      const result = await runJob(benchmarkRequest) ?? (benchmarkRequest.suiteId
        ? await bridge.runBenchmarkSuite(benchmarkRequest, benchmarkConfig, profileName)
        : await bridge.runBenchmark(benchmarkRequest, benchmarkConfig, profileName));
      set(s => ({ benchmarks: [result, ...s.benchmarks] }));
    }
    catch (e) {
      if (e instanceof BenchmarkJobCancelledError) set({ benchmarkProgress: undefined });
      else set({ error: benchmarkErrorMessage(e) });
    }
    finally { set({ busy: false, activeBenchmarkJobId: undefined }); }
  },
  cancelBenchmark: async () => {
    const jobId = get().activeBenchmarkJobId;
    if (!jobId || typeof bridge.cancelJob !== "function") return;
    try {
      await bridge.cancelJob(jobId);
      const current = get();
      if (current.activeBenchmarkJobId === jobId && current.benchmarkJob?.jobId === jobId) {
        set({ benchmarkJob: { ...current.benchmarkJob, status: "cancelling" } });
      }
    } catch (error) {
      if (get().activeBenchmarkJobId === jobId) set({ error: benchmarkErrorMessage(error) });
    }
  },
  runAutoTune: async request => {
    const initial = get();
    if (initial.busy || initial.optimizerRunning) return;
    const routerMode = initial.runningMode === "router" || (!initial.runningEngine && initial.settings.serverEngine === "llama_cpp" && initial.settings.serverMode === "router");
    const originalRuntimeConfig = initial.runningConfig && structuredClone(initial.runningConfig);
    const profileId = request.profileId ?? originalRuntimeConfig?.profileId ?? initial.config.profileId;
    const profile = initial.profiles.find(candidate => candidate.id === profileId)
      ?? (initial.config.profileId === profileId ? makeProfile(initial.config) : undefined);
    const managedRunsActive = initial.runs.filter(run => run.info.managed && activeRunState(run.info.state));
    const legacyMode = managedRunsActive.length === 0 && initial.runningEngine === "llama_cpp" && Boolean(originalRuntimeConfig) && ["ready", "busy"].includes(initial.runtime.state);
    if (!bridge.isTauri()) {
      set({ error: i18n.t("benchmark.autoTuneDesktopOnly") });
      return;
    }
    if ((initial.runningEngine ?? initial.settings.serverEngine) !== "llama_cpp" || !profileId || (routerMode && !profile)) {
      set({ error: i18n.t((initial.runningEngine ?? initial.settings.serverEngine) === "strata" ? "benchmark.autoTuneStrataUnsupported" : "benchmark.profileMustBeRunning") });
      return;
    }
    const hasUnscopedRuntime = activeRunState(initial.runtime.state) && !legacyMode;
    if (managedRunsActive.length > 0 || hasUnscopedRuntime) {
      set({ error: i18n.t("benchmark.trialRequiresAllRunsStopped") });
      return;
    }
    const recallSuite = initial.benchmarkSuites.find(suite => suite.id === "context-recall-v1");
    const stabilitySuite = initial.benchmarkSuites.find(suite => suite.id === "context-stability-v1");
    if (!recallSuite || !stabilitySuite) {
      set({ error: i18n.t("benchmark.suitesUnavailable") });
      return;
    }
    const effectiveSettings = { ...initial.settings, ...(legacyMode ? initial.runningRouterSettings ?? {} : {}), serverEngine: "llama_cpp" as const, serverMode: routerMode ? "router" as const : "single" as const };
    const baseConfig = withConfiguredBinary(structuredClone(routerMode ? profile!.config : originalRuntimeConfig ?? profile?.config ?? initial.config), effectiveSettings.binaryPath);
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
    const trialRunId = `trial:${crypto.randomUUID()}`;
    let trialStarted = false;

    const launchCandidate = async (candidateConfig: LaunchConfig) => {
      const launchConfig = routerMode ? routerRuntimeConfig(candidateConfig, effectiveSettings) : candidateConfig;
      if (legacyMode) {
        set(state => ({ runningConfig: launchConfig, runtime: { ...state.runtime, endpoint: `http://${launchConfig.host}:${launchConfig.port}`, state: "restarting" } }));
        const result = routerMode
          ? await bridge.restartRouter(launchConfig, effectiveSettings, initial.profiles.map(existing => existing.id === profileId ? { ...existing, config: candidateConfig } : existing), initial.capabilities)
          : await bridge.restartServer(launchConfig, initial.capabilities);
        set(state => ({ launchPid: result.pid, runtime: { ...state.runtime, state: "loading", pid: result.pid } }));
        const runtime = await waitForServerReady(launchConfig, routerMode);
        set({ runtime, launchPid: runtime.pid ?? result.pid });
        if (runtime.state !== "ready" && runtime.state !== "busy") throw new Error(runtime.lastError || `Server did not become ready (state: ${runtime.state}).`);
        return launchConfig;
      }
      if (trialStarted) await bridge.stopRun(trialRunId);
      const profiles = initial.profiles.map(existing => existing.id === profileId ? { ...existing, config: candidateConfig } : existing);
      const request = await bridge.createRunStartRequest({ runId: trialRunId, config: launchConfig, settings: effectiveSettings, profiles, capabilities: initial.capabilities });
      const started = await bridge.startRun(request);
      trialGeneration = started.generation;
      trialStarted = true;
      const runtime = await waitForManagedRunReady(trialRunId);
      if (runtime.state !== "ready" && runtime.state !== "busy") {
        throw new Error(runtime.lastError || `Server did not become ready (state: ${runtime.state}).`);
      }
      return endpointParts(runtime.endpoint, launchConfig);
    };

    let trialGeneration: number | undefined;
    const runTrialBenchmark = async (benchmarkRequest: BenchmarkRequest, launchConfig: LaunchConfig, profileName: string) => {
      if (!legacyMode && trialStarted && typeof bridge.runBenchmarkJob === "function") {
        return bridge.runBenchmarkJob(trialRunId, benchmarkRequest, {
          onStarted: job => {
            set(state => ({ benchmarkJob: job, activeBenchmarkJobId: job.jobId, benchmarkProgress: { ...state.benchmarkProgress, phase: "prepare" } }));
            if (get().optimizerCancelRequested && typeof bridge.cancelJob === "function") void bridge.cancelJob(job.jobId).catch(error => set({ error: benchmarkErrorMessage(error) }));
          },
          onState: job => {
            if (job.runId !== trialRunId || (trialGeneration !== undefined && job.generation !== trialGeneration)) return;
            set(state => ({
              benchmarkJob: job,
              activeBenchmarkJobId: ["completed", "cancelled", "failed", "interrupted"].includes(job.status) ? undefined : job.jobId,
              ...(job.status === "cancelled" ? { benchmarkProgress: undefined }
                : job.status === "completed" ? { benchmarkProgress: { ...state.benchmarkProgress, phase: "completed" as const } }
                  : ["failed", "interrupted"].includes(job.status) ? { benchmarkProgress: { ...state.benchmarkProgress, phase: "failed" as const } } : {}),
            }));
          },
          onProgress: event => {
            if (event.runId !== trialRunId || (trialGeneration !== undefined && event.generation !== trialGeneration)) return;
            set(state => ({
              benchmarkProgress: { ...state.benchmarkProgress, ...event.progress },
              benchmarkEvents: [...state.benchmarkEvents.slice(-19), { ...event.progress, timestamp: Date.now() }],
            }));
          },
        });
      }
      return bridge.runBenchmarkSuite(benchmarkRequest, launchConfig, profileName);
    };

    set({ busy: true, optimizerRunning: true, error: undefined, benchmarkJob: undefined, activeBenchmarkJobId: undefined, optimizerRecommendation: undefined, optimizerProfiles: [], optimizerCancelRequested: false, optimizerProgress: { current: 0, total: totalSteps, candidate: i18n.t("benchmark.tuningStarting") } });
    try {
      for (const candidate of candidates) {
        if (get().optimizerCancelRequested) break;
        step += 1;
        set({ optimizerProgress: { current: step, total: totalSteps, candidate: candidate.id } });
        try {
          const launchConfig = await launchCandidate(candidate.config);
          const model = routerMode ? routerModelId(profile!, initial.profiles) : candidate.config.modelAlias?.trim() || candidate.config.profileName;
          const result = await runTrialBenchmark({
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
            const throughput = await runTrialBenchmark({
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
        .filter(result => result.meetsTargets && extractBenchmarkLaunchConfig(result.configSnapshot))
        .sort((a, b) => (b.recommendationScore ?? 0) - (a.recommendationScore ?? 0))
        .slice(0, 3);
      const verificationCache = new Map<string, BenchmarkResult | null>();
      const goals: (BenchmarkProfileGoal | undefined)[] = profileSearch ? ["maxContext", "maxSpeed", "balanced"] : [undefined];
      for (const goal of goals) {
        const ranked = goal ? rankProfileResults(screened.filter(result => {
          const signature = JSON.stringify(extractBenchmarkLaunchConfig(result.configSnapshot));
          return !verificationCache.has(signature) || verificationCache.get(signature) !== null;
        }), goal, minimumContext) : finalists;
        for (const screenedResult of get().optimizerCancelRequested ? [] : ranked) {
          if (get().optimizerCancelRequested) break;
          const config = extractBenchmarkLaunchConfig(screenedResult.configSnapshot);
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
            const model = routerMode ? routerModelId(profile!, initial.profiles) : config.modelAlias?.trim() || config.profileName;
            const verified = await runTrialBenchmark({
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
            if (verified.meetsTargets && verified.suiteSummary?.passed && extractBenchmarkLaunchConfig(verified.configSnapshot)) {
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
        set({ optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.stoppingTrialBeforeSave") } });
      } else if (best) {
        set(state => ({ optimizerRecommendation: best, optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.tuningComplete") }, notices: withNotice(state.notices, makeNotice("success", i18n.t("benchmark.tuningRecommendationReady"))) }));
      } else {
        set({ optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.noPassingCandidate") }, ...(firstCandidateError ? { error: benchmarkErrorMessage(firstCandidateError) } : {}) });
      }
    } catch (error) {
      set({ error: benchmarkErrorMessage(error) });
    } finally {
      let trialStopped = false;
      try {
        if (legacyMode) {
          const restoredConfig = routerMode ? routerRuntimeConfig(originalRuntimeConfig!, effectiveSettings) : originalRuntimeConfig!;
          set(state => ({ runningConfig: restoredConfig, runtime: { ...state.runtime, endpoint: `http://${restoredConfig.host}:${restoredConfig.port}`, state: "restarting" } }));
          const restored = routerMode
            ? await bridge.restartRouter(restoredConfig, effectiveSettings, initial.profiles, initial.capabilities)
            : await bridge.restartServer(restoredConfig, initial.capabilities);
          set(state => ({ launchPid: restored.pid, runtime: { ...state.runtime, state: "loading", pid: restored.pid } }));
          const runtime = await waitForServerReady(restoredConfig, routerMode);
          if (runtime.state !== "ready" && runtime.state !== "busy") throw new Error(runtime.lastError || `Restore ended in state ${runtime.state}.`);
          set({ runningConfig: restoredConfig, runtime, launchPid: runtime.pid ?? restored.pid });
          trialStopped = true;
        } else {
          if (trialStarted) await bridge.stopRun(trialRunId);
          trialStopped = true;
        }
      } catch (cleanupError) {
        if (legacyMode) {
          set(state => ({ runningConfig: undefined, runningMode: undefined, runningEngine: undefined, launchPid: undefined, runtime: { ...state.runtime, state: "crashed", lastError: String(cleanupError) }, error: i18n.t("benchmark.restoreAfterTuningFailed", { error: String(cleanupError) }) }));
        } else set({ error: i18n.t("benchmark.trialCleanupFailed", { error: String(cleanupError) }) });
      } finally {
        if (trialStopped && profileSearch && !get().optimizerCancelRequested && selected.length) {
          try {
            for (const selection of selected) {
              if (get().optimizerCancelRequested) break;
              const config = extractBenchmarkLaunchConfig(selection.result.configSnapshot);
              if (!config) continue;
              config.profileId = crypto.randomUUID();
              config.profileName = `${profile?.name ?? baseConfig.profileName} · ${i18n.t(`benchmark.profileGoal.${selection.goal}`)} · ${config.ctxSize.toLocaleString(initial.settings.language)}`;
              const cloned = profile?.v2 ? await bridge.duplicateProfileSnapshot(profile, config.profileId, config.profileName) : undefined;
              let saved: LaunchProfile;
              try {
                saved = await bridge.saveProfile({ ...makeProfile(mergeBenchmarkLaunchConfig(cloned?.config ?? baseConfig, config), cloned), description: i18n.t("benchmark.autoProfileDescription", {
                contextTokens: config.ctxSize, speed: selection.result.averages.generationTps.toFixed(1),
                benchmarkId: selection.result.id, verificationId: selection.verification.id,
                }) });
              } catch (error) {
                if (cloned) {
                  try { await bridge.deleteProfile(cloned.id, cloned.revision); }
                  catch { set({ profiles: await bridge.listProfiles() }); }
                }
                throw error;
              }
              set(state => ({ profiles: [...state.profiles, saved], optimizerProfiles: [...state.optimizerProfiles, { ...selection, profile: saved }] }));
            }
            if (get().optimizerProfiles.length) {
              await get().syncRouterProfiles();
              set(state => ({ notices: withNotice(state.notices, makeNotice("success", i18n.t("benchmark.profilesSaved", { count: state.optimizerProfiles.length }))), optimizerProgress: { current: step, total: step, candidate: i18n.t("benchmark.tuningComplete") } }));
            }
          } catch (saveError) { set({ error: i18n.t("benchmark.profileSaveFailed", { error: String(saveError) }) }); }
        }
        set({ busy: false, activeBenchmarkJobId: undefined, optimizerCancelRequested: false, optimizerRunning: false });
      }
    }
  },
  cancelAutoTune: () => {
    if (!get().optimizerRunning) return;
    set({ optimizerCancelRequested: true });
    const jobId = get().activeBenchmarkJobId;
    if (jobId && typeof bridge.cancelJob === "function") void bridge.cancelJob(jobId).catch(error => set({ error: benchmarkErrorMessage(error) }));
  },
  applyOptimizerRecommendation: () => {
    const recommendation = get().optimizerRecommendation;
    const config = extractBenchmarkLaunchConfig(recommendation?.configSnapshot);
    if (config && !get().busy && !get().optimizerRunning) {
      const state = get();
      const source = state.config.profileId === config.profileId ? mergeBenchmarkLaunchConfig(state.config, captureEngineOptions(state.config, state.settings)) : state.profiles.find(profile => profile.id === config.profileId)?.config ?? state.config;
      const merged = mergeBenchmarkLaunchConfig(source, config);
      const settings = restoreEngineOptions(merged, state.settings);
      const sameRun = !state.selectedRunId || state.config.profileId === merged.profileId;
      const runDrafts = state.selectedRunId ? { ...state.runDrafts, [state.selectedRunId]: sameRun ? { config: merged, settings, dirty: true } : { config: state.config, settings: state.settings, dirty: state.dirty } } : state.runDrafts;
      set({ config: merged, settings, dirty: true, runDrafts, ...(sameRun ? {} : { selectedRunId: undefined }) });
    }
  },

  initialize: () => {
    if (get().initialized) return Promise.resolve();
    if (initializationInFlight) return initializationInFlight;
    initializationInFlight = (async () => {
    try {
      const [storedSettings, profiles, benchmarks, benchmarkSuites, knownGoodProfile, knownGoodRouter] = await Promise.all([bridge.getSettings(), bridge.listProfiles(), bridge.listBenchmarks(), bridge.listBenchmarkSuites(), bridge.loadLastKnownGood(), bridge.loadLastKnownGoodRouter()]);
      const rawEngine = (storedSettings as AppSettings & { serverEngine?: unknown }).serverEngine;
      const supportedEngine: ServerEngine | "" = isSupportedProfileEngine(typeof rawEngine === "string" ? rawEngine : undefined) ? rawEngine as ServerEngine : "";
      const legacyEngineId = typeof storedSettings.legacyEngineId === "string" && storedSettings.legacyEngineId.trim()
        ? storedSettings.legacyEngineId
        : typeof rawEngine === "string" && rawEngine && !supportedEngine ? rawEngine : null;
      let settings: AppSettings = { ...DEFAULT_SETTINGS, ...storedSettings, serverEngine: supportedEngine, legacyEngineId };
      if (!supportedEngine) settings = { ...settings, autoStartServer: false, routerAutoload: false };
      if (!storedSettings.routerApiKey.trim()) settings = await bridge.saveSettings({ ...settings, routerApiKey: generateRouterApiKey() });
      if (!storedSettings.setupCompleted) {
        const detectedLanguage = detectAppLanguage(typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
        if (detectedLanguage !== settings.language) settings = await bridge.saveSettings({ ...settings, language: detectedLanguage });
      }
      const installations = await bridge.availableEngines(settings);
      const installed = installations.map(item => item.id).filter(isSupportedProfileEngine);
      // Fill empty paths from verified discovery; preserve paths explicitly chosen by the user.
      const detectedPath = (id: ServerEngine) => installations.find(item => item.id === id)?.path ?? "";
      const discoveredSettings = {
        ...settings,
        binaryPath: settings.binaryPath || detectedPath("llama_cpp"),
        strataRootPath: settings.strataRootPath || detectedPath("strata"),
        serverEngine: supportedEngine,
      };
      // Missing and retired IDs stay unselected until the user chooses a supported engine.
      if (JSON.stringify(discoveredSettings) !== JSON.stringify(settings)) settings = await bridge.saveSettings(discoveredSettings);
      await i18n.changeLanguage(settings.language);
      set({ availableEngines: installed });
      const candidates = settings.serverEngine ? profiles.filter(profile => !profile.unsupportedEngine && (profile.config.engine ?? "llama_cpp") === settings.serverEngine) : [];
      const selected = (settings.serverEngine === "strata" ? candidates.find(profile => sameFilePath(String(profile.config.engineOptions?.strata?.strataConfigPath ?? ''), settings.strataConfigPath)) : undefined) ?? candidates[0];
      const config = withConfiguredBinary(selected?.config ?? { ...DEFAULT_CONFIG, ...(settings.serverEngine ? { engine: settings.serverEngine } : {}) }, settings.binaryPath);
      const optimizerRecommendation = benchmarks.find(result => result.autoTuneCandidate && result.suiteId === "context-stability-v1" && result.suiteSummary?.passed && result.meetsTargets && extractBenchmarkLaunchConfig(result.configSnapshot));
      set({ settings, profiles, benchmarks, benchmarkSuites, optimizerProgress: undefined, optimizerRecommendation, optimizerProfiles: [], optimizerCancelRequested: false, optimizerRunning: false, knownGoodProfile: knownGoodProfile ?? undefined, knownGoodRouter: knownGoodRouter ?? undefined, config, savedConfig: config, logs: bridge.isTauri() ? [] : MOCK_LOGS });
      await syncWindowsAutostart(settings.startWithWindows).catch(() => undefined);
      await get().loadRuns();
      set({ initialized: true });
      const initializationTasks = [get().rescanModels(), get().refreshRuntime()];
      if (settings.serverEngine === "llama_cpp" && installed.includes("llama_cpp")) initializationTasks.push(get().detectBinary());
      await Promise.allSettled(initializationTasks);
      const hasSelectedModel = settings.serverEngine === "strata" ? Boolean(settings.strataConfigPath) : settings.serverEngine === "llama_cpp" && Boolean(config.modelPath);
      if (settings.serverEngine && settings.setupCompleted && settings.autoStartServer && settings.serverEngine === storedSettings.serverEngine && installed.includes(settings.serverEngine) && hasSelectedModel && get().runtime.state === "stopped") await get().startManagedRun();
    } catch (e) { set({ initialized: true, error: String(e) }); }
    })().finally(() => { initializationInFlight = undefined; });
    return initializationInFlight;
  },
}));
