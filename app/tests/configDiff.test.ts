import { describe, expect, it } from "vitest";
import { configDiff } from "../src/lib/configDiff";
import { DEFAULT_CONFIG } from "../src/types/config";

describe("configDiff", () => {
  it("returns only changed registry fields", () => {
    const after = { ...DEFAULT_CONFIG, ctxSize: 131072, parallel: 4 };
    const changes = configDiff(DEFAULT_CONFIG, after);
    expect(changes.map(change => change.key)).toEqual(["ctxSize", "parallel"]);
  });

  it("masks API key values", () => {
    const before = { ...DEFAULT_CONFIG, apiKey: "old-secret" };
    const after = { ...before, apiKey: "new-secret" };
    const change = configDiff(before, after).find(item => item.key === "apiKey");
    expect(change?.before).toBe("••••••");
    expect(change?.after).toBe("••••••");
  });
});
