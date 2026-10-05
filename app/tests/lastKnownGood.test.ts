import { describe, expect, it } from "vitest";
import { shouldCommitReadyLaunch } from "../src/lib/lastKnownGood";

describe("last-known-good snapshots", () => {
  it("commits only when the launched process reaches ready", () => {
    expect(shouldCommitReadyLaunch("loading", 42, 42, 1, 0)).toBe(false);
    expect(shouldCommitReadyLaunch("crashed", undefined, 42, 1, 0)).toBe(false);
    expect(shouldCommitReadyLaunch("ready", 41, 42, 1, 0)).toBe(false);
    expect(shouldCommitReadyLaunch("ready", 42, 42, 1, 0)).toBe(true);
  });

  it("does not recommit on each ready poll, but accepts a later launch even if Windows reuses its PID", () => {
    expect(shouldCommitReadyLaunch("ready", 42, 42, 1, 1)).toBe(false);
    expect(shouldCommitReadyLaunch("ready", 42, 42, 2, 1)).toBe(true);
  });
});
