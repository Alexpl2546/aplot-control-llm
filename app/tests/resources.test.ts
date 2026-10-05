import { describe, expect, it } from "vitest";
import { estimateResources } from "../src/lib/resources";
import { TEST_CONFIG } from "./fixtures";
describe("resource estimator",()=>{it("returns finite estimates",()=>{const r=estimateResources(TEST_CONFIG,16);expect(Number.isFinite(r.estimatedVramGiB)).toBe(true);expect(r.modelGiB).toBeGreaterThan(0);expect(r.confidence).toBe("low")});it("q4 KV is smaller than f16 KV",()=>{const f=estimateResources({...TEST_CONFIG,cacheTypeK:"f16",cacheTypeV:"f16"});const q=estimateResources({...TEST_CONFIG,cacheTypeK:"q4_0",cacheTypeV:"q4_0"});expect(q.kvCacheGiB).toBeLessThan(f.kvCacheGiB)});});
