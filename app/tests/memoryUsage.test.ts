import { describe, expect, it } from "vitest";
import { memoryModel, type MemoryRun } from "../src/features/resources/memoryUsage";
import { runColor } from "../src/features/launches/presentation";
import { DEFAULT_CONFIG } from "../src/types/config";

const run = (runId: string, engine: MemoryRun["info"]["engine"] = "llama_cpp"): MemoryRun => ({
  info: { runId, name: runId, state: "ready", engine, mode: "single" },
  config: { ...DEFAULT_CONFIG, modelBytes: 8 * 1024 ** 3, modelLayers: 32, modelEmbeddingLength: 4096, modelHeadCount: 32, modelHeadCountKv: 8 },
});

describe("system memory presentation", () => {
  it('attributes measured Strata process-tree memory instead of merging it into the system', () => {
    const strata = run('strata', 'strata');
    strata.runtime = { processMemory: { ramMiB: 25 * 1024, vramMiB: 12.8 * 1024, pids: [1, 2], sampledAtMs: Date.now() } };
    const ram = memoryModel('ram', [strata], 64 * 1024, 42 * 1024);
    const vram = memoryModel('vram', [strata], 16 * 1024, 15 * 1024);
    expect(ram.segments[0]).toMatchObject({ runId: 'strata', gib: 25, basis: 'measured' });
    expect(ram.otherGib).toBe(17);
    expect(vram.segments[0].gib).toBeCloseTo(12.8);
    expect(vram.otherGib).toBeCloseTo(2.2);
    expect(vram.unestimated).toEqual([]);
  });

  it('handles unavailable GPU attribution and stale process samples independently', () => {
    const strata = run('strata', 'strata');
    strata.runtime = { processMemory: { ramMiB: 1024, vramMiB: null, pids: [1], sampledAtMs: Date.now() } };
    expect(memoryModel('ram', [strata], 64000, 4000).segments[0].basis).toBe('measured');
    expect(memoryModel('vram', [strata], 16000, 4000).segments).toEqual([]);
    strata.runtime.processMemory!.sampledAtMs = Date.now() - 10000;
    expect(memoryModel('ram', [strata], 64000, 4000).segments).toEqual([]);
  });

  it('prefers process readings over the model estimator and fits asynchronous totals safely', () => {
    const cpp = run('cpp');
    cpp.runtime = { processMemory: { ramMiB: 10000, vramMiB: 10000, pids: [1], sampledAtMs: Date.now() } };
    const model = memoryModel('vram', [cpp], 16000, 8000);
    expect(model.scaled).toBe(true);
    expect(model.segments[0].basis).toBe('measured');
    expect(model.segments[0].estimatedGib).toBeCloseTo(10000 / 1024);
    expect(model.segments[0].gib).toBeCloseTo(8000 / 1024);
    expect(model.otherGib).toBe(0);
  });
  it.each(["vram", "ram"] as const)("bounds scaled %s shares to measured usage while retaining original estimates", kind => {
    const model = memoryModel(kind, [run("a"), run("b")], 64 * 1024, 1024);
    expect(model.scaled).toBe(true);
    expect(model.segments.reduce((sum, segment) => sum + segment.gib, 0)).toBeCloseTo(1);
    expect(model.segments.every(segment => segment.estimatedGib > segment.gib)).toBe(true);
    expect(model.otherGib).toBeCloseTo(0);
  });

  it("can scale RAM without scaling VRAM", () => {
    const runs = [run("a"), run("b")];
    expect(memoryModel("vram", runs, 64 * 1024, 40 * 1024).scaled).toBe(false);
    expect(memoryModel("ram", runs, 64 * 1024, 1024).scaled).toBe(true);
  });

  it("keeps unsupported engines, routers and missing metadata unattributed", () => {
    const router = run("router"); router.info.mode = "router";
    const unknown = run("unknown"); unknown.config.modelHeadCountKv = undefined;
    const model = memoryModel("vram", [run("legacy", "legacy"), router, unknown], 16 * 1024, 5 * 1024);
    expect(model.segments).toEqual([]);
    expect(model.unestimated.map(item => item.info.runId)).toEqual(["legacy", "router", "unknown"]);
    expect(model.otherGib).toBe(5);
  });

  it("excludes stopped and crashed runs and never changes their launch snapshots", () => {
    const stopped = run("stopped"), crashed = run("crashed");
    stopped.info.state = "stopped"; crashed.info.state = "crashed";
    const runs = [run("active"), stopped, crashed], original = structuredClone(runs);
    memoryModel("ram", runs, 64 * 1024, 5 * 1024);
    expect(memoryModel("vram", runs, 16 * 1024, 5 * 1024).segments.map(segment => segment.runId)).toEqual(["active"]);
    expect(runs).toEqual(original);
  });

  it("retains each server's color when the list is reordered", () => {
    const original = ["profile:a", "profile:b"].map(id => ({ id, color: runColor(id) }));
    const reordered = ["profile:b", "profile:a"].map(id => ({ id, color: runColor(id) })).reverse();
    expect(reordered).toEqual(original);
  });
});
