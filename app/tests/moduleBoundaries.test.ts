import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const verifier = fileURLToPath(new URL("../scripts/verify-modules.mjs", import.meta.url));
const roots = ["launches/launchActions", "launches/presentation", "resources/memoryUsage", "resources/planner", "models/artifactCatalog", "profiles/profileAdapters", "connections/harnesses"];

function verify(memorySource: string, helperSource = "export const estimate = 1;") {
  const root = mkdtempSync(path.join(tmpdir(), "aplot-modules-"));
  const write = (file: string, text: string) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  try {
    for (const module of roots) write(`src/features/${module}.ts`, "export {};");
    write("src/features/resources/memoryUsage.ts", memorySource);
    write("src/features/resources/estimate.ts", helperSource);
    write("src/store/control.ts", "export const state = {};");
    return spawnSync(process.execPath, [verifier, "--root", root], { encoding: "utf8", timeout: 10000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("module boundary enforcement", () => {
  it("allows type-only contracts without importing the store at runtime", () => {
    expect(verify('import type { state } from "../../store/control"; export {};').status).toBe(0);
  });
  it("rejects a store dependency hidden behind an estimator helper", () => {
    const result = verify('import { estimate } from "./estimate";', 'import { state } from "../../store/control"; export const estimate = state;');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("memoryUsage.ts → src/features/resources/estimate.ts → src/store/control.ts");
  });
  it("rejects dynamic native imports in a pure module", () => {
    expect(verify('export const read = () => import("@tauri-apps/api/core");').status).toBe(1);
  });
  it("rejects a production dependency on the archived redesign", () => {
    const result = verify('export * from "../../../_redesign/anything";');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("design copy");
  });
});
