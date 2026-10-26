import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { loadArtifactCatalog } from "../src/features/models/artifactCatalogBridge";

beforeEach(() => vi.resetAllMocks());
it("requests the native metadata catalog without arguments", async () => {
  const catalog = { scannedAt: "now", roots: ["C:/models"], logicalBytes: 100, uniquePhysicalBytes: 50, artifacts: [], missingReferences: [], issues: [] };
  mocks.invoke.mockResolvedValue(catalog);
  expect(await loadArtifactCatalog()).toEqual(catalog);
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("model_catalog");
});
it("propagates scan failure instead of presenting example files", async () => {
  mocks.invoke.mockRejectedValue(new Error("Scan failed"));
  await expect(loadArtifactCatalog()).rejects.toThrow("Scan failed");
});
