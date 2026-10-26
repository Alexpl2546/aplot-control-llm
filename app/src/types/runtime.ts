import type { ServerEngine } from "./app";

export type ServerState = "stopped" | "starting" | "loading" | "ready" | "busy" | "stopping" | "restarting" | "crashed";
export type ManagedEngine = ServerEngine;
export type ManagedMode = "single" | "router";

export interface RunInfo {
  runId: string;
  name: string;
  engine: ManagedEngine;
  mode: ManagedMode;
  endpoint: string;
  modelId: string;
  contextTokens: number;
  state: ServerState;
  pid?: number;
  generation: number;
  managed: boolean;
  startedAt?: string;
  lastError?: string;
}

export interface StartRunRequest {
  autoPort?: boolean;
  runId: string;
  name: string;
  engine: ManagedEngine;
  mode: ManagedMode;
  modelId: string;
  contextTokens: number;
  launch: Record<string, unknown>;
}

export interface RunLogEvent { runId: string; generation: number; line: LogLine; }
export interface RunStateEvent { runId: string; generation: number; state: ServerState; }

export interface SparkPoint { t: number; value: number; }
export interface GpuSnapshot { name: string; utilization: number; memoryUsedMiB: number; memoryTotalMiB: number; temperatureC: number; powerW: number | null; powerLimitW: number | null; powerReading?: "instant" | "average" | "reported" | null; clockMHz: number; }
export interface CpuSnapshot { name: string; utilization: number; threads: number; clockMHz: number; temperatureC?: number; }
export interface MemoryModule { manufacturer?: string | null; partNumber?: string | null; capacityMiB: number; memoryType?: string | null; speedMtps?: number | null; }
export interface MemorySnapshot { usedMiB: number; totalMiB: number; modules?: MemoryModule[]; }
export interface InferenceSlot {
  id: number;
  modelId?: string;
  state: "idle" | "prompt" | "generating" | "error";
  contextUsed: number;
  contextTotal: number;
  generationTps?: number;
  promptTps?: number;
  taskId?: number;
}
export interface RuntimeSnapshot {
  processMemory?: { ramMiB: number | null; vramMiB: number | null; pids: number[]; sampledAtMs: number } | null;
  state: ServerState;
  uptimeSeconds: number;
  endpoint: string;
  backend: string;
  modelName?: string;
  pid?: number;
  processStartedAt?: string;
  lastError?: string;
  gpu: GpuSnapshot;
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  generationTps: number;
  generationMeanTps?: number | null;
  generationWindowSeconds?: number | null;
  promptTps: number;
  activeRequests: number;
  queuedRequests: number;
  ttftMs: number | null;
  contextUsed: number;
  contextTotal: number;
  slots: InferenceSlot[];
  metricsAvailable: boolean;
  slotsAvailable: boolean;
  healthStatus: number;
}
export interface LogLine {
  id: string;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  source: "stdout" | "stderr" | "control";
  message: string;
}
export interface RuntimeHistoryPoint {
  timestamp: number;
  gpu: number;
  vramMiB: number;
  gpuTemperatureC: number;
  gpuPowerW: number | null;
  cpu: number;
  ramMiB: number;
  generationTps: number;
  generationMeanTps?: number | null;
  promptTps: number;
  activeRequests: number;
  queuedRequests: number;
  ttftMs: number | null;
}
