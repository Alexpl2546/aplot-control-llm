import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/types/app";
import { DEFAULT_CONFIG } from "../src/types/config";
import { executeLaunchIntent, LaunchChangedError, planLaunchAction, type LaunchActionState } from "../src/features/launches/launchActions";

function fixture(dirty = true): LaunchActionState {
  return {
    selectedRunId: "a", config: { ...DEFAULT_CONFIG, ctxSize: 32768 }, settings: DEFAULT_SETTINGS,
    dirty, optimizerRunning: false, runBusyById: {}, runtime: { state: "ready" },
    runs: [{ info: { runId: "a", state: "ready", generation: 2 } }, { info: { runId: "b", state: "ready", generation: 1 } }],
  };
}

describe("shared launch action", () => {
  it("does not apply or save a dirty draft until it is confirmed", async () => {
    const state = fixture(), start = vi.fn(), restart = vi.fn();
    const port = { read: () => state, start, restart };
    const intent = planLaunchAction(state, "restart")!;
    expect(intent.needsConfirmation).toBe(true);
    await executeLaunchIntent(port, intent);
    expect(restart).not.toHaveBeenCalled();
    expect(state.dirty).toBe(true);
    await executeLaunchIntent(port, intent, true);
    expect(restart).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("allows a clean restart without confirmation", async () => {
    const state = fixture(false), restart = vi.fn();
    await executeLaunchIntent({ read: () => state, start: vi.fn(), restart }, planLaunchAction(state, "restart")!);
    expect(restart).toHaveBeenCalledExactlyOnceWith("a");
  });

  it.each(["selection", "draft", "generation", "busy", "optimizer"])("rejects stale confirmation after a %s change", async change => {
    const state = fixture(), restart = vi.fn();
    const intent = planLaunchAction(state, "restart")!;
    if (change === "selection") state.selectedRunId = "b";
    if (change === "draft") state.config = { ...state.config, ctxSize: 65536 };
    if (change === "generation") state.runs[0].info.generation++;
    if (change === "busy") state.runBusyById.a = true;
    if (change === "optimizer") state.optimizerRunning = true;
    await expect(executeLaunchIntent({ read: () => state, start: vi.fn(), restart }, intent, true)).rejects.toBeInstanceOf(LaunchChangedError);
    expect(restart).not.toHaveBeenCalled();
  });

  it("starts a stopped run after confirmation and never calls restart", async () => {
    const state = fixture(), start = vi.fn(), restart = vi.fn();
    state.runs[0].info.state = "stopped";
    await executeLaunchIntent({ read: () => state, start, restart }, planLaunchAction(state, "start")!, true);
    expect(start).toHaveBeenCalledExactlyOnceWith("a");
    expect(restart).not.toHaveBeenCalled();
  });

  it("blocks conflicting actions during lifecycle transitions", () => {
    const state = fixture();
    state.runs[0].info.state = "loading";
    expect(planLaunchAction(state, "restart")).toBeUndefined();
    expect(planLaunchAction(state, "start")).toBeUndefined();
    expect(planLaunchAction(state, "restart", "b")).toBeUndefined();
  });

  it("allows a new profile to start while the facade retains the previous server's metrics", () => {
    const state = fixture();
    state.selectedRunId = undefined;
    state.runtime.state = "ready";
    expect(planLaunchAction(state, "start")).toMatchObject({ action: "start", runId: undefined, needsConfirmation: true });
    expect(planLaunchAction(state, "restart")).toBeUndefined();
  });
});
