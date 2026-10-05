import { describe, expect, it } from "vitest";
import { parseCapabilities } from "../src/lib/capabilities";
import { buildBenchmarkCandidates, buildProfileSearchCandidates, rankProfileResults } from "../src/lib/benchmarkOptimizer";
import { TEST_CONFIG } from "./fixtures";
import { MOCK_BENCHMARKS } from "../src/mocks/runtime";

describe("automatic benchmark candidates", () => {
  it("creates a baseline and only varies parameters supported by --help", () => {
    const capabilities = parseCapabilities(
      "llama.cpp b5000",
      "--model --batch-size --ubatch-size --parallel --cache-type-k --cache-type-v f16 q8_0 q4_0",
    );
    const candidates = buildBenchmarkCandidates(TEST_CONFIG, capabilities);

    expect(candidates[0]).toMatchObject({ id: "baseline", config: TEST_CONFIG, changedKeys: [] });
    expect(candidates.map(candidate => candidate.id)).toContain("batch-1024");
    expect(candidates.map(candidate => candidate.id)).toContain("parallel-1");
    expect(candidates.some(candidate => candidate.id.startsWith("kv-"))).toBe(true);
    expect(candidates.every(candidate => candidate.config.ubatchSize <= candidate.config.batchSize)).toBe(true);
  });

  it("keeps only the baseline when tuning flags are absent", () => {
    const capabilities = parseCapabilities("llama.cpp b5000", "--model");
    expect(buildBenchmarkCandidates(TEST_CONFIG, capabilities)).toHaveLength(1);
  });
});

describe("context and speed profile search", () => {
  const capabilities = parseCapabilities("llama.cpp", "--model --ctx-size --parallel --fit --batch-size --ubatch-size --cache-type-k --cache-type-v f16 q8_0 q4_0");
  it("searches the floor, intermediate sizes and exact upper bound with one fixed slot", () => {
    const candidates = buildProfileSearchCandidates(TEST_CONFIG, capabilities, 65536, 200000);
    expect([...new Set(candidates.map(candidate => candidate.config.ctxSize))]).toEqual([65536, 131072, 200000]);
    expect(candidates.every(candidate => candidate.config.parallel === 1 && !candidate.config.fit)).toBe(true);
    expect(candidates.some(candidate => candidate.config.cacheTypeK === "q4_0")).toBe(true);
    expect(candidates.length).toBeLessThanOrEqual(18);
    expect(TEST_CONFIG.parallel).toBe(2);
    expect(TEST_CONFIG.fit).toBe(true);
  });
  it.each([[32768, 262144], [65536, 32768], [65536, Infinity], [NaN, 262144], [65536, 1048577]])("rejects invalid bounds %s / %s", (min, max) => {
    expect(buildProfileSearchCandidates(TEST_CONFIG, capabilities, min, max)).toEqual([]);
  });
  it("requires flags that guarantee the context floor", () => {
    const caps = parseCapabilities("llama.cpp", "--model --ctx-size");
    expect(buildProfileSearchCandidates(TEST_CONFIG, caps, 65536, 131072)).toEqual([]);
    expect(buildProfileSearchCandidates({ ...TEST_CONFIG, parallel: 1, fit: false }, caps, 65536, 131072)).toHaveLength(2);
  });
  it.each(["--ctx-size=8192", "-np 4", "--fit on", "--cache-type-k q4_0", "-b 4096"])("rejects extra argument overrides: %s", extraArgs => {
    expect(buildProfileSearchCandidates({ ...TEST_CONFIG, extraArgs }, capabilities, 65536, 131072)).toEqual([]);
  });
  it("ranks three goals by measured decode speed and context while excluding ineligible runs", () => {
    const result = (id: string, ctxSize: number, speed: number, meetsTargets = true) => ({
      ...MOCK_BENCHMARKS[0], id, meetsTargets, configSnapshot: { ...TEST_CONFIG, ctxSize, parallel: 1, fit: false },
      averages: { ...MOCK_BENCHMARKS[0].averages, generationTps: speed },
    });
    const results = [result("speed", 65536, 100), result("balance", 131072, 80), result("context", 262144, 30), result("failed", 524288, 1000, false), result("too-small", 32768, 2000), result("nan", 131072, NaN)];
    expect(rankProfileResults(results, "maxContext", 65536)[0].id).toBe("context");
    expect(rankProfileResults(results, "maxSpeed", 65536)[0].id).toBe("speed");
    expect(rankProfileResults(results, "balanced", 65536)[0].id).toBe("balance");
    expect(rankProfileResults(results, "balanced", 65536)).toHaveLength(3);
  });
});
