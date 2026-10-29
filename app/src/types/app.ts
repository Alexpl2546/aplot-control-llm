import type { LaunchConfig, LlamaCapabilities } from "./config";

export type SettingsSection = "general" | "engine" | "components" | "connections" | "agents";
export type AppView = "dashboard" | "configuration" | "models" | "profiles" | "performance" | "logs" | "apiDocs" | "settings" | "chat" | "agentWorkspace" | "knowledge";
export type AppLanguage = "en" | "ru" | "de" | "fr" | "es" | "pt" | "it" | "zh" | "ja" | "ko";
export type ThemePreference = "dark" | "light" | "system";
export type ServerMode = "single" | "router";
export type ServerEngine = "llama_cpp" | "strata";
export type LegacyEngineId = "ollama" | "qwfnfer" | "infernix";
export type SavedEngineId = ServerEngine | LegacyEngineId | (string & {});


export const DASHBOARD_WIDGET_IDS = [
  "hardware.gpu",
  "hardware.cpu",
  "hardware.memory",
  "inference.generation",
  "inference.prompt",
  "inference.activeRequests",
  "inference.queuedRequests",
  "inference.ttft",
  "inference.context",
  "inference.slots",
  "charts.throughput",
  "charts.hardware",
  "charts.memory",
  "charts.thermals",
  "charts.requests",
] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

export interface DashboardRect { x: number; y: number; w: number; h: number; }
export interface DashboardLayout { version: 1; items: Partial<Record<DashboardWidgetId, DashboardRect>>; }

export const DEFAULT_DASHBOARD_WIDGETS: DashboardWidgetId[] = [...DASHBOARD_WIDGET_IDS];

const legacyDashboardWidgets: Record<string, readonly DashboardWidgetId[]> = {
  hardware: ["hardware.gpu", "hardware.cpu", "hardware.memory"],
  inference: [
    "inference.generation",
    "inference.prompt",
    "inference.activeRequests",
    "inference.queuedRequests",
    "inference.ttft",
    "inference.context",
    "inference.slots",
  ],
  charts: ["charts.throughput", "charts.hardware", "charts.memory", "charts.thermals", "charts.requests"],
  quickConfig: [],
};

export function normalizeDashboardWidgets(widgets: readonly string[] | undefined): DashboardWidgetId[] {
  if (widgets === undefined) return [...DEFAULT_DASHBOARD_WIDGETS];

  const selected = new Set<DashboardWidgetId>();
  const validIds = new Set<string>(DASHBOARD_WIDGET_IDS);
  const add = (widget: DashboardWidgetId) => selected.add(widget);
  for (const id of widgets) {
    if (id === "logs") continue;
    const legacyGroup = legacyDashboardWidgets[id];
    if (legacyGroup) {
      legacyGroup.forEach(add);
    } else if (validIds.has(id)) {
      add(id as DashboardWidgetId);
    }
  }

  return [...selected];
}

export type NoticeKind = "success" | "info" | "warning" | "error";
export interface NoticeAction { label: string; run: () => void | Promise<void>; }
export interface AppNotice { id: string; kind: NoticeKind; message: string; createdAt: number; action?: NoticeAction; durationMs?: number; }

export interface AppSettings {
  setupCompleted: boolean;
  language: AppLanguage;
  theme: ThemePreference;
  dashboardWidgets: DashboardWidgetId[];
  dashboardLayout: DashboardLayout | null;
  favoriteModelIds: string[];
  pinnedServerIds: string[];
  uiScale: number;
  binaryPath: string;
  modelDirectories: string[];
  pollIntervalMs: number;
  autoStartServer: boolean;
  startWithWindows: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  logRetentionLines: number;
  benchmarkRuns: number;
  serverEngine: ServerEngine | "";
  legacyEngineId?: string | null;
  strataRootPath: string;
  strataConfigPath: string;
  strataHost: string;
  strataPort: number;
  strataApiKey: string;
  /** "router" puts every Strata model behind one address that switches models. */
  strataServerMode: ServerMode;
  serverMode: ServerMode;
  routerHost: string;
  routerPort: number;
  routerMaxLoadedModels: number;
  routerAutoload: boolean;
  routerApiKey: string;
}

export interface LaunchProfile {
  revision?: number;
  v2?: import("../features/profiles/bridge").NativeProfileV2;
  id: string;
  name: string;
  description?: string;
  config: LaunchConfig;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastKnownGood: boolean;
  /** Unsupported native profile engine. Kept for inspection and export only. */
  unsupportedEngine?: string;
}

export type RouterSnapshotSettings = Pick<AppSettings,
  "binaryPath" | "serverMode" | "routerHost" | "routerPort" | "routerMaxLoadedModels" | "routerAutoload" | "routerApiKey"
>;

export interface RouterRecoverySnapshot {
  profiles: LaunchProfile[];
  config: LaunchConfig;
  settings: RouterSnapshotSettings;
}

export interface ModelInfo {
  id: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: string;
  quantization?: string;
  architecture?: string;
  parameterCount?: string;
  contextLength?: number;
  modelName?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface LlamaDevice { id: string; name: string; memoryMiB?: number; freeMiB?: number; raw: string; }

export interface StrataModelOption {
  configPath: string;
  modelPath?: string;
  modelName: string;
  contextLength: number;
}

export interface DetectionResult {
  versionOutput: string;
  helpOutput: string;
  capabilities: LlamaCapabilities;
  devices: LlamaDevice[];
}

export interface CommonLocationDiscovery {
  binaryCandidates: string[];
  modelDirectories: string[];
}

export interface ScanRoot {
  path: string;
  label: string;
}

export interface BenchmarkRequest {
  profileId?: string;
  model?: string;
  promptTokens: number;
  generationTokens: number;
  runs: number;
  prompt?: string;
  suiteId?: string;
  suiteVersion?: number;
  objective?: "speed" | "quality" | "balanced";
  minimumQuality?: number;
  minimumGenerationTps?: number;
  expectedAnswers?: Record<string, string>;
  configSnapshot?: Partial<LaunchConfig>;
  autoTuneCandidate?: boolean;
  contextLimitTokens?: number;
  windowCount?: number;
  autoSelectProfiles?: boolean;
  minimumContextTokens?: number;
  maximumContextTokens?: number;
}

export type BenchmarkProfileGoal = "maxContext" | "maxSpeed" | "balanced";
export interface BenchmarkProfileSelection {
  goal: BenchmarkProfileGoal;
  result: BenchmarkResult;
  verification: BenchmarkResult;
  profile: LaunchProfile;
}

export interface BenchmarkSuiteDefinition {
  id: string;
  version: number;
  kind: "throughput" | "exact_recall" | "context_continuity";
  nameKey: string;
  descriptionKey: string;
  defaultPromptTokens: number;
  defaultGenerationTokens: number;
  defaultRuns: number;
  probeCount: number;
  windowCount: number;
  minimumAccuracy: number | null;
  promptTargetRatio?: number;
  checkpointMaxTokens?: number;
}

export interface BenchmarkSample {
  run: number;
  promptTps: number;
  generationTps: number;
  ttftMs: number | null;
  totalMs: number;
  vramPeakMiB: number;
  ramPeakMiB: number;
  gpuPeakPercent: number;
  qualityScore?: number | null;
  qualityMatches?: number | null;
  qualityTotal?: number | null;
  phase?: string | null;
  window?: number | null;
  promptTokenCount?: number | null;
  outputTokenCount?: number | null;
}

export interface BenchmarkResult {
  id: string;
  profileId?: string;
  profileName: string;
  createdAt: string;
  request: BenchmarkRequest;
  samples: BenchmarkSample[];
  averages: Omit<BenchmarkSample, "run">;
  suiteId?: string | null;
  suiteVersion?: number | null;
  objective?: "speed" | "quality" | "balanced" | null;
  configSnapshot?: Partial<LaunchConfig> | import("./runtime").StartRunRequest | {
    run: import("./runtime").StartRunRequest;
    editorConfiguration: Partial<LaunchConfig> | null;
    editorConfigurationSource: "caller";
  } | null;
  autoTuneCandidate?: boolean | null;
  meetsTargets?: boolean | null;
  recommendationScore?: number | null;
  suiteSummary?: BenchmarkSuiteSummary | null;
  suiteWindows?: BenchmarkSuiteWindow[];
}

export interface BenchmarkSuiteSummary {
  completedWindows: number;
  requestedWindows: number;
  currentAccuracy: number;
  carryoverAccuracy: number | null;
  checkpointAccuracy: number;
  passed: boolean;
  randomSeed: number;
}

export interface BenchmarkSuiteWindow {
  run: number;
  window: number;
  promptTokens: number;
  configuredContextTokens?: number | null;
  expectedCurrent: Record<string, string>;
  currentMatches: number;
  currentTotal: number;
  expectedCarryover: Record<string, string>;
  carryoverMatches: number;
  carryoverTotal: number;
  checkpointMatches: number;
  checkpointTotal: number;
  checkpointOutputTokens: number;
  randomSeed: number;
  status: string;
  failureReason?: string | null;
  actualCurrent: Record<string, string>;
  actualCarryover: Record<string, string>;
  recall: BenchmarkSample;
  compaction: BenchmarkSample;
  checkpointJson?: Record<string, unknown> | null;
}

export interface BenchmarkTuningProgress {
  current: number;
  total: number;
  candidate: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  setupCompleted: false,
  language: "en",
  theme: "dark",
  binaryPath: "",
  modelDirectories: [],
  dashboardWidgets: [...DEFAULT_DASHBOARD_WIDGETS],
  dashboardLayout: null,
  favoriteModelIds: [],
  pinnedServerIds: [],
  uiScale: 0,
  pollIntervalMs: 1000,
  autoStartServer: false,
  startWithWindows: false,
  minimizeToTray: true,
  closeToTray: true,
  logRetentionLines: 5000,
  benchmarkRuns: 5,
  serverEngine: "llama_cpp",
  strataRootPath: "",
  strataConfigPath: "",
  strataHost: "127.0.0.1",
  strataPort: 8090,
  strataApiKey: "",
  strataServerMode: "single",
  serverMode: "router",
  routerHost: "127.0.0.1",
  routerPort: 8080,
  routerMaxLoadedModels: 1,
  routerAutoload: true,
  routerApiKey: "",
};

export interface BenchmarkProgress {
  phase: "prepare" | "throughput" | "recall" | "compaction" | "sample" | "completed" | "failed";
  completed?: number;
  total?: number;
  run?: number;
  window?: number;
  sample?: BenchmarkSample | null;
}
