/** Contract v1. All memory values are bytes, finite safe nonnegative integers. */
export type ResourceEngine = "llama_cpp" | "strata";
export type Placement = "allGpu" | "hybrid" | "cpu" | "engineManaged";
export type PlanStatus = "withinEstimate" | "advisory" | "unknown" | "insufficient";
export interface ByteRange { min: number; max: number | null }
export interface PoolBudget {
  totalBytes?: number;
  observedUsedBytes?: number;
  freeBytes?: number;
  /** Shared global allocation cap; applying it requires known global usage. */
  limitBytes?: number;
  spareBytes: number;
}
export interface HardwareBudget {
  snapshotId: string;
  snapshotAgeMs: number;
  maxSnapshotAgeMs: number;
  ram: PoolBudget;
  /** Separate pinned allocation constraint; pinned bytes are also part of RAM. */
  pinnedRam?: PoolBudget;
  gpus: Record<string, PoolBudget>;
}
export interface ResourceAmounts {
  ramBytes: number;
  pinnedRamBytes: number;
  gpuBytes: Record<string, number>;
}
export interface ResourceClaim {
  claimId: string;
  /** Process/service identity, not model/profile identity. */
  ownerId: string;
  generation: number;
  amounts: ResourceAmounts;
}
export interface ResourceObservation {
  snapshotId: string;
  ownerId: string;
  generation: number;
  ramBytes?: number;
  pinnedRamBytes?: number;
  gpuBytes: Record<string, number>;
}
export interface AccountingInput {
  hardware: HardwareBudget;
  claims: ResourceClaim[];
  observations: ResourceObservation[];
}
export interface AccountedPool {
  baseFreeBytes: number | null;
  availableBytes: number | null;
  residualReservedBytes: number;
  spareBytes: number;
  reasons: string[];
}
export interface ResourceAvailability {
  ram: AccountedPool;
  pinnedRam: AccountedPool | null;
  gpus: Record<string, AccountedPool>;
}
export interface KvMetadata {
  layers: number;
  kvHeads: number;
  keyHeadDim: number;
  valueHeadDim: number;
  /** Include quantization block overhead; no cache type defaults are guessed. */
  keyBytesPerElement: number;
  valueBytesPerElement: number;
}
export interface ModelResourceMetadata {
  artifactBytes?: number;
  format: "gguf" | "other" | "unknown";
  weightsComplete: boolean;
  architecture: "dense" | "moe" | "unknown";
  attention: "standard" | "other" | "unknown";
  kv?: KvMetadata;
}
export interface EngineResourceOptions {
  placement: Placement;
  gpuId?: string;
  gpuLayers?: number;
  kvOnGpu: boolean;
  /** Total allocated KV cells, NOT per-slot context multiplied implicitly. */
  kvCapacityTokens?: number;
  kvCapacityScalesWithContext: boolean;
  unmodelledAllocations: boolean;
  workspaceRam?: ByteRange;
  workspaceGpu?: ByteRange;
  /** Explicit externally established disjoint floors, never copied from UI budgets. */
  extraRamBytes: number;
  pinnedRamBytes: number;
  extraGpuBytes: Record<string, number>;
  gpuBudgetBytes: Record<string, number>;
  spareRamBytes: number;
  spareGpuBytes: Record<string, number>;
}
export interface ResourceRequest {
  engine: ResourceEngine;
  model: ModelResourceMetadata;
  contextTokens: number;
  minimumContextTokens: number;
  options: EngineResourceOptions;
}
export interface ResourcePlannerInput extends AccountingInput { request: ResourceRequest }
export interface ResourceEstimate {
  artifactBytes: number | null;
  kv: ByteRange | null;
  ram: ByteRange;
  pinnedRam: ByteRange;
  gpus: Record<string, ByteRange>;
  confidence: "low" | "medium" | "unknown";
  source: "llamaDenseApproximation" | "knownFloorsOnly";
  reasons: string[];
}
export interface PoolAssessment {
  pool: string;
  required: ByteRange;
  availableBytes: number | null;
  status: PlanStatus;
}
export interface ResourceCandidate {
  id: "configured" | "allGpu" | "hybrid" | "cpu" | "reducedContext";
  placement: Placement;
  gpuLayers: number | null;
  contextTokens: number;
  kvCapacityTokens: number | null;
  estimate: ResourceEstimate;
  status: PlanStatus;
  assessments: PoolAssessment[];
}
export interface ResourcePlan {
  contractVersion: 1;
  availability: ResourceAvailability;
  candidates: ResourceCandidate[];
  /** All variants require user selection and runtime verification. */
  automaticApplication: false;
}
