import { describe, expect, it } from "vitest";
import { accountResources, planResources, ResourcePlannerError } from "../src/features/resources/planner";
import type { AccountingInput, ResourceClaim, ResourcePlannerInput } from "../src/features/resources/types";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
function fixture(): ResourcePlannerInput {
  return {
    hardware: { snapshotId: "sample-1", snapshotAgeMs: 0, maxSnapshotAgeMs: 1000,
      ram: { totalBytes: 64 * GiB, observedUsedBytes: 8 * GiB, spareBytes: 4 * GiB },
      gpus: { gpu0: { totalBytes: 16 * GiB, observedUsedBytes: 2 * GiB, spareBytes: GiB } } },
    claims: [], observations: [], request: { engine: "llama_cpp", contextTokens: 8192, minimumContextTokens: 6000,
      model: { artifactBytes: 4 * GiB, format: "gguf", weightsComplete: true, architecture: "dense", attention: "standard", kv: { layers: 32, kvHeads: 8, keyHeadDim: 128, valueHeadDim: 128, keyBytesPerElement: 2, valueBytesPerElement: 2 } },
      options: { placement: "allGpu", gpuId: "gpu0", kvOnGpu: true, kvCapacityTokens: 8192, kvCapacityScalesWithContext: true, unmodelledAllocations: false,
        workspaceRam: { min: 256 * MiB, max: 512 * MiB }, workspaceGpu: { min: 256 * MiB, max: 512 * MiB },
        extraRamBytes: 0, pinnedRamBytes: 0, extraGpuBytes: {}, gpuBudgetBytes: {}, spareRamBytes: 0, spareGpuBytes: {} } },
  };
}
function claim(ram: number, gpu: number): ResourceClaim {
  return { claimId: "lease-a", ownerId: "process-a", generation: 1, amounts: { ramBytes: ram, pinnedRamBytes: 0, gpuBytes: { gpu0: gpu } } };
}
function configured(input = fixture()) { return planResources(input).candidates[0]; }

describe("resource planner: uncertainty and allocation strategies", () => {
  it("uses explicit standard dense KV capacity and gives an approximate range", () => {
    const r = configured();
    expect(r.estimate.kv).toEqual({ min: GiB, max: Math.ceil(1.1 * GiB + 16 * MiB) });
    expect(r.estimate.gpus.gpu0.min).toBe(Math.ceil(.95 * 4 * GiB) + GiB + 256 * MiB);
    expect(r.estimate.ram.max).toBe(5 * GiB + 512 * MiB);
    expect(r.estimate.confidence).toBe("medium");
    expect(r.status).toBe("withinEstimate");
    expect(r.estimate.reasons.join(" ")).toContain("not certified upper bounds");
  });
  it("does not multiply an already total cache capacity by parallel slots", () => {
    const input = fixture(); input.request.options.kvCapacityTokens = 16384;
    expect(configured(input).estimate.kv?.min).toBe(2 * GiB);
  });
  it("distinguishes a range crossing free capacity from definite insufficiency", () => {
    const input = fixture(); input.hardware.gpus.gpu0 = { freeBytes: 6 * GiB, spareBytes: 0 };
    expect(configured(input).status).toBe("advisory");
    input.hardware.gpus.gpu0.freeBytes = 4 * GiB;
    expect(configured(input).status).toBe("insufficient");
  });
  it("does not turn enormous MoE files into dense resident memory", () => {
    const input = fixture(); input.request.model.architecture = "moe"; input.request.model.artifactBytes = 512 * GiB;
    const plan = planResources(input);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ status: "unknown", estimate: { confidence: "unknown", kv: null, ram: { min: 0, max: null } } });
  });
  it("keeps Strata engine-managed allocation unknown even with dense metadata", () => {
    const engine = "strata";
    const input = fixture(); input.request.engine = engine; input.request.options.placement = "engineManaged";
    const plan = planResources(input);
    expect(plan.candidates).toHaveLength(1); expect(plan.candidates[0].status).toBe("unknown");
    expect(plan.candidates[0].estimate.reasons.join(" ")).toContain(`${engine} has no calibrated allocation strategy`);
  });
  it("rejects unsupported generic placement options on another engine", () => {
    const input = fixture(); input.request.engine = "strata";
    expect(() => planResources(input)).toThrow("Only llama_cpp");
  });
  it.each(["other", "unknown"] as const)("does not use full KV formula for %s attention", attention => {
    const input = fixture(); input.request.model.attention = attention;
    expect(configured(input).estimate.kv).toBeNull(); expect(configured(input).status).toBe("unknown");
  });
  it("requires metadata and total KV capacity instead of guessed defaults", () => {
    const input = fixture(); delete input.request.options.kvCapacityTokens;
    expect(configured(input).status).toBe("unknown");
    input.request.options.kvCapacityTokens = 8192; delete input.request.model.kv;
    expect(configured(input).status).toBe("unknown");
  });
  it("does not bound incomplete shards or unmodelled draft/projector allocations", () => {
    const input = fixture(); input.request.model.weightsComplete = false;
    expect(configured(input).status).toBe("unknown");
    input.request.model.weightsComplete = true; input.request.options.unmodelledAllocations = true;
    expect(configured(input).estimate.ram.max).toBeNull();
  });
  it("never reduces minimum context or changes input when proposing variants", () => {
    const input = fixture(); const before = structuredClone(input); const plan = planResources(input);
    expect(plan.automaticApplication).toBe(false);
    expect(plan.candidates.map(c => c.id)).toEqual(["configured", "hybrid", "cpu", "reducedContext"]);
    expect(plan.candidates.find(c => c.id === "reducedContext")).toMatchObject({ contextTokens: 6000, kvCapacityTokens: 6000 });
    expect(plan.candidates.find(c => c.id === "cpu")?.estimate.gpus).toEqual({}); expect(input).toEqual(before);
    input.request.options.kvCapacityScalesWithContext = false;
    expect(planResources(input).candidates.some(c => c.id === "reducedContext")).toBe(false);
  });
  it("does not combine free memory on unrelated GPU devices", () => {
    const input = fixture(); input.hardware.gpus.gpu0.freeBytes = 3 * GiB;
    input.hardware.gpus.gpu1 = { totalBytes: 80 * GiB, observedUsedBytes: 0, spareBytes: 0 };
    expect(configured(input).status).toBe("insufficient");
  });
  it("applies shared/request spare as their maximum and a per-run GPU budget as a cap", () => {
    const input = fixture(); input.request.options.spareGpuBytes.gpu0 = 2 * GiB;
    let gpu = configured(input).assessments.find(a => a.pool === "gpu:gpu0")!;
    expect(gpu.availableBytes).toBe(12 * GiB);
    input.request.options.gpuBudgetBytes.gpu0 = 4 * GiB;
    expect(configured(input).status).toBe("insufficient");
    input.hardware.gpus.gpu0 = { totalBytes: 16 * GiB, spareBytes: 0 };
    expect(configured(input).status).toBe("insufficient");
  });
  it("reports unbounded workspace as unknown and default workspace as low confidence", () => {
    const input = fixture(); input.request.options.workspaceGpu = { min: 0, max: null };
    expect(configured(input).status).toBe("unknown");
    delete input.request.options.workspaceGpu;
    expect(configured(input).estimate.confidence).toBe("low");
  });
});

describe("resource accounting: occupied, observed and reserved", () => {
  it("adds only the not-yet-observed part of an existing reservation", () => {
    const input = fixture(); input.hardware.ram.observedUsedBytes = 20 * GiB; input.hardware.gpus.gpu0.observedUsedBytes = 8 * GiB;
    input.claims = [claim(10 * GiB, 6 * GiB)];
    input.observations = [{ snapshotId: "sample-1", ownerId: "process-a", generation: 1, ramBytes: 8 * GiB, gpuBytes: { gpu0: 4 * GiB } }];
    const a = accountResources(input);
    expect(a.ram).toMatchObject({ residualReservedBytes: 2 * GiB, availableBytes: 38 * GiB });
    expect(a.gpus.gpu0).toMatchObject({ residualReservedBytes: 2 * GiB, availableBytes: 5 * GiB });
  });
  it("keeps unattributed claims conservative and ignores stale snapshot/generation attribution", () => {
    const input = fixture(); input.claims = [claim(4 * GiB, GiB)];
    for (const [snapshotId, generation] of [["old", 1], ["sample-1", 0]] as const) {
      input.observations = [{ snapshotId, ownerId: "process-a", generation, ramBytes: 4 * GiB, gpuBytes: { gpu0: GiB } }];
      expect(accountResources(input).ram.residualReservedBytes).toBe(4 * GiB);
    }
  });
  it("does not subtract observations without a global usage baseline", () => {
    const input = fixture(); input.hardware.ram = { freeBytes: 20 * GiB, spareBytes: 0 }; input.claims = [claim(4 * GiB, 0)];
    input.observations = [{ snapshotId: "sample-1", ownerId: "process-a", generation: 1, ramBytes: 4 * GiB, gpuBytes: {} }];
    expect(accountResources(input).ram.availableBytes).toBe(16 * GiB);
  });
  it("uses the lower free reading and preserves external occupied memory", () => {
    const input = fixture(); input.hardware.ram.freeBytes = 50 * GiB;
    expect(accountResources(input).ram.availableBytes).toBe(46 * GiB);
    input.hardware.ram.limitBytes = 32 * GiB;
    expect(accountResources(input).ram.availableBytes).toBe(20 * GiB);
  });
  it("never treats absent/stale telemetry as zero load", () => {
    const input = fixture(); input.hardware.ram = { totalBytes: 64 * GiB, spareBytes: 0 };
    expect(accountResources(input).ram.availableBytes).toBeNull(); expect(configured(input).status).toBe("unknown");
    input.hardware = fixture().hardware; input.hardware.snapshotAgeMs = 1001;
    expect(configured(input).status).toBe("unknown");
  });
  it("rejects duplicate claims, excessive attribution, inconsistent and unsafe numbers", () => {
    const input = fixture(); input.claims = [claim(GiB, GiB), { ...claim(GiB, GiB), claimId: "another" }];
    expect(() => accountResources(input)).toThrow(ResourcePlannerError);
    input.claims = []; input.observations = [{ snapshotId: "sample-1", ownerId: "x", generation: 0, ramBytes: 9 * GiB, gpuBytes: {} }];
    expect(() => accountResources(input)).toThrow("Attributed usage");
    input.observations = []; input.hardware.ram.freeBytes = 64 * GiB;
    expect(() => accountResources(input)).toThrow("exceeds totalBytes");
    input.hardware.ram = { freeBytes: Number.MAX_SAFE_INTEGER + 1, spareBytes: 0 };
    expect(() => accountResources(input)).toThrow(ResourcePlannerError);
  });
  it("keeps pinned RAM as a subset rather than adding it to RAM twice", () => {
    const input = fixture(); input.hardware.pinnedRam = { freeBytes: 4 * GiB, spareBytes: 0 };
    input.claims = [{ ...claim(4 * GiB, 0), amounts: { ramBytes: 4 * GiB, pinnedRamBytes: 2 * GiB, gpuBytes: {} } }];
    const a = accountResources(input); expect(a.ram.residualReservedBytes).toBe(4 * GiB); expect(a.pinnedRam?.residualReservedBytes).toBe(2 * GiB);
  });
});
