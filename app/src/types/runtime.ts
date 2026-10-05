export type ServerState = "stopped" | "starting" | "loading" | "ready" | "busy" | "stopping" | "restarting" | "crashed";

export interface SparkPoint { t: number; value: number; }
export interface GpuSnapshot { name: string; utilization: number; memoryUsedMiB: number; memoryTotalMiB: number; temperatureC: number; powerW: number; powerLimitW: number; clockMHz: number; }
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
  gpuPowerW: number;
  cpu: number;
  ramMiB: number;
  generationTps: number;
  generationMeanTps?: number | null;
  promptTps: number;
  activeRequests: number;
  queuedRequests: number;
  ttftMs: number | null;
}
