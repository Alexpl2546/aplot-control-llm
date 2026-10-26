import type {
  AccountingInput, AccountedPool, ByteRange, EngineResourceOptions, PoolBudget,
  ResourceAvailability, ResourceCandidate, ResourceEstimate, ResourcePlan,
  ResourcePlannerInput, ResourceRequest, ResourceObservation, PlanStatus,
} from "./types";

const MiB = 1024 ** 2;
const MAX = Number.MAX_SAFE_INTEGER;
export class ResourcePlannerError extends Error {
  readonly code = "invalidInput";
}
function fail(message: string): never { throw new ResourcePlannerError(message); }
function bytes(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a nonnegative safe integer.`);
}
function positive(value: number, name: string): void { bytes(value, name); if (value === 0) fail(`${name} must be positive.`); }
function sum(values: number[]): number {
  const value = values.reduce((a, b) => a + b, 0);
  bytes(value, "Memory sum");
  return value;
}
function byteMap(map: Record<string, number>, name: string): void {
  for (const [id, value] of Object.entries(map)) { if (!id.trim() || ["ram", "pinnedRam"].includes(id)) fail(`${name} has a reserved/empty device ID.`); bytes(value, `${name}.${id}`); }
}
function validatePool(pool: PoolBudget): void {
  bytes(pool.spareBytes, "spareBytes");
  for (const key of ["totalBytes", "observedUsedBytes", "freeBytes", "limitBytes"] as const) {
    if (pool[key] !== undefined) bytes(pool[key], key);
  }
  if (pool.totalBytes !== undefined && (
    (pool.observedUsedBytes ?? 0) > pool.totalBytes || (pool.freeBytes ?? 0) > pool.totalBytes ||
    (pool.observedUsedBytes !== undefined && pool.freeBytes !== undefined && pool.observedUsedBytes + pool.freeBytes > pool.totalBytes)
  )) fail("Memory telemetry exceeds totalBytes.");
}
function usage(pool: PoolBudget): number | undefined {
  return pool.observedUsedBytes ?? (pool.totalBytes !== undefined && pool.freeBytes !== undefined ? pool.totalBytes - pool.freeBytes : undefined);
}
function observationValue(observation: ResourceObservation, pool: string): number | undefined {
  return pool === "ram" ? observation.ramBytes : pool === "pinnedRam" ? observation.pinnedRamBytes : observation.gpuBytes[pool];
}
function claimValue(input: AccountingInput["claims"][number], pool: string): number {
  return pool === "ram" ? input.amounts.ramBytes : pool === "pinnedRam" ? input.amounts.pinnedRamBytes : input.amounts.gpuBytes[pool] ?? 0;
}
function validateAccounting(input: AccountingInput): void {
  const h = input.hardware;
  if (!h.snapshotId.trim()) fail("snapshotId is required.");
  bytes(h.snapshotAgeMs, "snapshotAgeMs"); bytes(h.maxSnapshotAgeMs, "maxSnapshotAgeMs");
  validatePool(h.ram); if (h.pinnedRam) validatePool(h.pinnedRam);
  for (const [id, pool] of Object.entries(h.gpus)) { if (["ram", "pinnedRam"].includes(id) || !id.trim()) fail("Reserved/empty GPU ID."); validatePool(pool); }
  const ids = new Set<string>(); const owners = new Set<string>();
  for (const claim of input.claims) {
    if (!claim.claimId.trim() || !claim.ownerId.trim()) fail("Claim identity is required.");
    bytes(claim.generation, "generation");
    if (ids.has(claim.claimId) || owners.has(JSON.stringify([claim.ownerId, claim.generation]))) fail("Duplicate claim or owner generation.");
    ids.add(claim.claimId); owners.add(JSON.stringify([claim.ownerId, claim.generation]));
    bytes(claim.amounts.ramBytes, "ramBytes"); bytes(claim.amounts.pinnedRamBytes, "pinnedRamBytes");
    if (claim.amounts.pinnedRamBytes > claim.amounts.ramBytes) fail("Pinned RAM must be included in RAM.");
    byteMap(claim.amounts.gpuBytes, "gpuBytes");
  }
  const observations = new Set<string>();
  for (const o of input.observations) {
    if (!o.ownerId.trim() || !o.snapshotId.trim()) fail("Observation identity is required.");
    bytes(o.generation, "generation");
    const key = JSON.stringify([o.snapshotId, o.ownerId, o.generation]);
    if (observations.has(key)) fail("Duplicate observation."); observations.add(key);
    if (o.ramBytes !== undefined) bytes(o.ramBytes, "observed ramBytes");
    if (o.pinnedRamBytes !== undefined) bytes(o.pinnedRamBytes, "observed pinnedRamBytes");
    if (o.ramBytes !== undefined && o.pinnedRamBytes !== undefined && o.pinnedRamBytes > o.ramBytes) fail("Observed pinned RAM exceeds RAM.");
    byteMap(o.gpuBytes, "observed gpuBytes");
  }
}
function accountPool(input: AccountingInput, id: string, pool: PoolBudget): AccountedPool {
  const reasons: string[] = [];
  const globalUsed = usage(pool);
  const current = input.observations.filter(o => o.snapshotId === input.hardware.snapshotId);
  const attributed = sum(current.map(o => observationValue(o, id) ?? 0));
  if (globalUsed !== undefined && attributed > globalUsed) fail(`Attributed usage exceeds global usage in ${id}.`);
  const residualReservedBytes = sum(input.claims.map(claim => {
    const o = current.find(o => o.ownerId === claim.ownerId && o.generation === claim.generation);
    const included = o && globalUsed !== undefined ? observationValue(o, id) : undefined;
    if (claimValue(claim, id) > 0 && included === undefined) reasons.push("Unattributed reservation is counted in full; telemetry overlap is unknown.");
    return Math.max(0, claimValue(claim, id) - (included ?? 0));
  }));
  const freeValues: number[] = [];
  if (pool.freeBytes !== undefined) freeValues.push(pool.freeBytes);
  if (pool.totalBytes !== undefined && pool.observedUsedBytes !== undefined) freeValues.push(pool.totalBytes - pool.observedUsedBytes);
  let baseFreeBytes = freeValues.length ? Math.min(...freeValues) : null;
  if (pool.limitBytes !== undefined) {
    if (globalUsed === undefined) { baseFreeBytes = null; reasons.push("Global usage is required to apply the shared allocation cap."); }
    else if (baseFreeBytes !== null) baseFreeBytes = Math.min(baseFreeBytes, Math.max(0, pool.limitBytes - globalUsed));
  }
  let availableBytes = baseFreeBytes === null ? null : Math.max(0, baseFreeBytes - residualReservedBytes - pool.spareBytes);
  if (baseFreeBytes === null) reasons.push("Free memory is unknown; total capacity alone is not availability.");
  if (input.hardware.snapshotAgeMs > input.hardware.maxSnapshotAgeMs) { availableBytes = null; reasons.push("Hardware snapshot is stale."); }
  return { baseFreeBytes, availableBytes, residualReservedBytes, spareBytes: pool.spareBytes, reasons: [...new Set(reasons)] };
}
export function accountResources(input: AccountingInput): ResourceAvailability {
  validateAccounting(input);
  return {
    ram: accountPool(input, "ram", input.hardware.ram),
    pinnedRam: input.hardware.pinnedRam ? accountPool(input, "pinnedRam", input.hardware.pinnedRam) : null,
    gpus: Object.fromEntries(Object.entries(input.hardware.gpus).map(([id, pool]) => [id, accountPool(input, id, pool)])),
  };
}
function validateRange(range: ByteRange): void { bytes(range.min, "range.min"); if (range.max !== null) { bytes(range.max, "range.max"); if (range.max < range.min) fail("Range maximum is below minimum."); } }
function validateRequest(r: ResourceRequest): void {
  if (!["llama_cpp", "strata"].includes(r.engine)) fail("Unknown engine.");
  if (!["dense", "moe", "unknown"].includes(r.model.architecture) || !["standard", "other", "unknown"].includes(r.model.attention)) fail("Unknown model metadata kind.");
  if (!["gguf", "other", "unknown"].includes(r.model.format) || typeof r.model.weightsComplete !== "boolean") fail("Invalid model artifact metadata.");
  positive(r.contextTokens, "contextTokens"); positive(r.minimumContextTokens, "minimumContextTokens");
  if (r.minimumContextTokens > r.contextTokens) fail("Minimum context exceeds configured context.");
  if (r.model.artifactBytes !== undefined) bytes(r.model.artifactBytes, "artifactBytes");
  const o = r.options;
  if (!["allGpu", "hybrid", "cpu", "engineManaged"].includes(o.placement)) fail("Unknown placement.");
  if (typeof o.kvOnGpu !== "boolean" || typeof o.kvCapacityScalesWithContext !== "boolean" || typeof o.unmodelledAllocations !== "boolean") fail("Resource flags must be boolean.");
  if (r.engine !== "llama_cpp" && o.placement !== "engineManaged") fail("Only llama_cpp exposes generic placement variants.");
  if (["allGpu", "hybrid"].includes(o.placement) && !o.gpuId?.trim()) fail("Explicit GPU ID is required for this placement.");
  if (o.gpuId !== undefined && (!o.gpuId.trim() || ["ram", "pinnedRam"].includes(o.gpuId))) fail("Reserved/empty GPU ID.");
  if (o.placement === "cpu" && o.kvOnGpu) fail("CPU placement cannot offload KV to GPU.");
  if (o.gpuLayers !== undefined) bytes(o.gpuLayers, "gpuLayers");
  if (o.placement === "hybrid" && o.gpuLayers === undefined) fail("Hybrid placement requires gpuLayers.");
  if (o.kvCapacityTokens !== undefined) { positive(o.kvCapacityTokens, "kvCapacityTokens"); if (o.kvCapacityTokens < r.contextTokens) fail("KV capacity is below configured context."); }
  for (const key of ["extraRamBytes", "pinnedRamBytes", "spareRamBytes"] as const) bytes(o[key], key);
  for (const key of ["extraGpuBytes", "gpuBudgetBytes", "spareGpuBytes"] as const) byteMap(o[key], key);
  if (o.workspaceRam) validateRange(o.workspaceRam); if (o.workspaceGpu) validateRange(o.workspaceGpu);
  if (r.model.kv) {
    for (const key of ["layers", "kvHeads", "keyHeadDim", "valueHeadDim"] as const) positive(r.model.kv[key], key);
    for (const key of ["keyBytesPerElement", "valueBytesPerElement"] as const) if (!Number.isFinite(r.model.kv[key]) || r.model.kv[key] <= 0 || r.model.kv[key] > 8) fail("Invalid KV bytes per element.");
    if (o.gpuLayers !== undefined && o.gpuLayers > r.model.kv.layers) fail("gpuLayers exceeds known layer count.");
  }
}
function range(min: number, max: number | null): ByteRange {
  const result = { min: Math.ceil(min), max: max === null ? null : Math.ceil(max) };
  validateRange(result); return result;
}
function add(a: ByteRange, b: ByteRange): ByteRange { return range(a.min + b.min, a.max === null || b.max === null ? null : a.max + b.max); }
function knownDense(r: ResourceRequest): boolean {
  return r.engine === "llama_cpp" && r.model.architecture === "dense" && r.model.attention === "standard" &&
    r.model.format === "gguf" && r.model.weightsComplete && !r.options.unmodelledAllocations &&
    Boolean(r.model.artifactBytes && r.model.kv && r.options.kvCapacityTokens) && r.options.placement !== "engineManaged";
}
function estimate(r: ResourceRequest): ResourceEstimate {
  const o = r.options;
  const pinned = o.pinnedRamBytes;
  const ramFloor = sum([pinned, o.extraRamBytes]);
  const gpus: Record<string, ByteRange> = Object.fromEntries(Object.entries(o.extraGpuBytes).map(([id, value]) => [id, range(value, value)]));
  if (!knownDense(r)) {
    for (const id of Object.keys(gpus)) gpus[id].max = null;
    if (o.gpuId) gpus[o.gpuId] = range(gpus[o.gpuId]?.min ?? 0, null);
    return {
      artifactBytes: r.model.artifactBytes ?? null, kv: null,
      ram: range(ramFloor, null), pinnedRam: range(pinned, null), gpus,
      confidence: "unknown", source: "knownFloorsOnly",
      reasons: ["No validated full allocation model: engine, architecture, attention, artifact bytes, placement or KV capacity/metadata is incomplete.",
        ...(r.engine !== "llama_cpp" ? [`${r.engine} has no calibrated allocation strategy in planner v1.`] : []),
        ...(r.model.architecture !== "dense" ? ["Expert residency/paging and unknown architectures are not inferred from total artifact bytes."] : []),
        ...(r.model.attention !== "standard" ? ["SWA, MLA, recurrent and mixed attention cannot use the uniform full KV formula."] : []),
        ...(!r.model.weightsComplete || r.model.format !== "gguf" || o.unmodelledAllocations ? ["Incomplete/non-GGUF weights or unmodelled dependencies invalidate the dense allocation envelope."] : []),
        "Disk artifact bytes are not a resident-memory bound for MoE/streaming engines.", "Only explicit disjoint allocation floors are counted; unreported workspace, caches and loading peaks remain unknown."],
    };
  }
  const k = r.model.kv!; const w = r.model.artifactBytes!;
  const nominalKv = k.layers * k.kvHeads * (k.keyHeadDim * k.keyBytesPerElement + k.valueHeadDim * k.valueBytesPerElement) * o.kvCapacityTokens!;
  if (!Number.isFinite(nominalKv) || nominalKv > MAX) fail("KV estimate exceeds the supported byte range.");
  const kv = range(nominalKv, nominalKv * 1.10 + 16 * MiB);
  const fraction = o.placement === "allGpu" ? 1 : o.placement === "cpu" ? 0 : o.gpuLayers! / k.layers;
  const lo = o.placement === "hybrid" ? Math.max(0, fraction - 0.15) : fraction;
  const hi = o.placement === "hybrid" ? Math.min(1, fraction + 0.15) : fraction;
  const workspaceRam = o.workspaceRam ?? range(256 * MiB, 1024 * MiB);
  let ram = add(range(ramFloor + 0.95 * w * Math.max(0, 1 - hi), ramFloor + 1.25 * w), workspaceRam);
  if (!o.kvOnGpu) ram = add(ram, kv);
  const useGpu = fraction > 0 || o.kvOnGpu;
  if (useGpu) {
    if (!o.gpuId) fail("GPU KV allocation requires an explicit GPU ID.");
    let gpu = add(range(0.95 * w * lo, 1.20 * w * hi), o.workspaceGpu ?? range(256 * MiB, 2048 * MiB));
    if (o.kvOnGpu) gpu = add(gpu, kv);
    gpus[o.gpuId] = add(gpus[o.gpuId] ?? range(0, 0), gpu);
  }
  const calibratedWorkspace = o.workspaceRam?.max != null && (!useGpu || o.workspaceGpu?.max != null);
  return {
    artifactBytes: w, kv,
    ram, pinnedRam: range(pinned, pinned), gpus,
    confidence: calibratedWorkspace && o.placement !== "hybrid" ? "medium" : "low",
    source: "llamaDenseApproximation",
    reasons: ["Approximate standard dense MHA/GQA weights + KV allocation; ranges are engineering allowances, not certified upper bounds.", "RAM upper estimate retains a full weight staging allowance even for GPU offload; mmap/page cache/copies vary by build.", "KV capacity is the supplied total cache capacity; parallel slots are not multiplied again.", ...(calibratedWorkspace ? [] : ["Missing workspace envelope uses uncalibrated RAM 256–1024 MiB and GPU 256–2048 MiB allowances."]), ...(o.placement === "hybrid" ? ["Layer-based offload has ±15 percentage-point placement uncertainty for non-layer tensors."] : [])],
  };
}
function assess(pool: string, required: ByteRange, accounted: AccountedPool | undefined | null, spare: number, cap?: number) {
  let available = accounted?.availableBytes ?? null;
  if (available !== null) { available = Math.max(0, available - Math.max(0, spare - accounted!.spareBytes)); if (cap !== undefined) available = Math.min(available, cap); }
  let status: PlanStatus;
  if (required.min === 0 && required.max === 0) status = "withinEstimate";
  else if (available !== null && required.min > available || cap !== undefined && required.min > cap) status = "insufficient";
  else if (available === null || required.max === null) status = "unknown";
  else status = required.max <= available ? "withinEstimate" : "advisory";
  return { pool, required, availableBytes: available, status };
}
function candidate(id: ResourceCandidate["id"], r: ResourceRequest, availability: ResourceAvailability): ResourceCandidate {
  const e = estimate(r); const o = r.options;
  const assessments = [assess("ram", e.ram, availability.ram, o.spareRamBytes), assess("pinnedRam", e.pinnedRam, availability.pinnedRam, 0),
    ...Object.entries(e.gpus).map(([gpuId, required]) => assess(`gpu:${gpuId}`, required, availability.gpus[gpuId], o.spareGpuBytes[gpuId] ?? 0, o.gpuBudgetBytes[gpuId]))];
  const priority: PlanStatus[] = ["insufficient", "unknown", "advisory", "withinEstimate"];
  return { id, placement: o.placement, gpuLayers: o.gpuLayers ?? null, contextTokens: r.contextTokens, kvCapacityTokens: o.kvCapacityTokens ?? null, estimate: e,
    status: priority.find(status => assessments.some(a => a.status === status))!, assessments };
}
/** Pure advisory planning. Does not reserve memory or mutate engine options. */
export function planResources(input: ResourcePlannerInput): ResourcePlan {
  validateRequest(input.request);
  const availability = accountResources(input);
  const r = input.request;
  const candidates = [candidate("configured", r, availability)];
  if (knownDense(r)) {
    const variant = (id: ResourceCandidate["id"], options: EngineResourceOptions) => candidates.push(candidate(id, { ...r, options }, availability));
    if (r.options.gpuId && input.hardware.gpus[r.options.gpuId]) {
      if (r.options.placement !== "allGpu") variant("allGpu", { ...r.options, placement: "allGpu", gpuLayers: undefined });
      if (r.model.kv!.layers > 1 && r.options.placement !== "hybrid") variant("hybrid", { ...r.options, placement: "hybrid", gpuLayers: Math.floor(r.model.kv!.layers / 2) });
    }
    if (r.options.placement !== "cpu") variant("cpu", { ...r.options, placement: "cpu", gpuLayers: 0, kvOnGpu: false });
    if (r.options.kvCapacityScalesWithContext && r.contextTokens > r.minimumContextTokens) {
      const contextTokens = Math.max(r.minimumContextTokens, Math.floor(r.contextTokens / 2));
      const options = { ...r.options, kvCapacityTokens: Math.ceil(r.options.kvCapacityTokens! * contextTokens / r.contextTokens) };
      candidates.push(candidate("reducedContext", { ...r, contextTokens, options }, availability));
    }
  }
  return { contractVersion: 1, availability, candidates, automaticApplication: false };
}
