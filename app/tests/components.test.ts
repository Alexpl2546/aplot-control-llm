import { describe, expect, it } from "vitest";
import { isRemovedComponentPath } from "../src/services/components";

describe("component settings cleanup", () => {
  it("clears only paths inside the removed version, with Windows case and separators", () => {
    const removed = ["C:\\Components\\strata\\0.1.45"];
    expect(isRemovedComponentPath("c:/components/STRATA/0.1.45/engine/strata.exe", removed)).toBe(true);
    expect(isRemovedComponentPath("C:/Components/strata/0.1.45", removed)).toBe(true);
    expect(isRemovedComponentPath("C:/Components/strata/0.1.450/model", removed)).toBe(false);
    expect(isRemovedComponentPath("C:/Models/example.gguf", removed)).toBe(false);
    expect(isRemovedComponentPath("", removed)).toBe(false);
  });
});
