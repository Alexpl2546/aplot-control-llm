import { describe, expect, it } from "vitest";
import { mergeModelDirectories } from "../src/lib/modelDirectories";

describe("model folder setup", () => {
  it("keeps existing folders and adds the selected folder once", () => {
    expect(mergeModelDirectories(["C:\\LLM-Bench\\active", "C:\\AI\\Models"], "C:/LLM-Bench/active/"))
      .toEqual(["C:\\LLM-Bench\\active", "C:\\AI\\Models"]);
  });

  it("ignores blank entries and trims paths", () => {
    expect(mergeModelDirectories(["  C:\\AI\\Models  "], "  "))
      .toEqual(["C:\\AI\\Models"]);
  });
});
