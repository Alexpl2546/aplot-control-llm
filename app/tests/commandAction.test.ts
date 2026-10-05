import { describe, expect, it } from "vitest";
import { commandRunAction } from "../src/lib/commandAction";

describe("generated command action", () => {
  it("starts a stopped or crashed server", () => {
    expect(commandRunAction("stopped")).toBe("start");
    expect(commandRunAction("crashed")).toBe("start");
  });

  it("restarts an active or transitioning server", () => {
    for (const state of ["starting", "loading", "ready", "busy", "stopping", "restarting"] as const) {
      expect(commandRunAction(state)).toBe("restart");
    }
  });
});
