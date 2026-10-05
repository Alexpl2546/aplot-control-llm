import { describe, expect, it } from "vitest";
import { getTrayServerPresentation, type TrayLabels } from "../src/services/desktop";

const labels: TrayLabels = {
  show: "Open",
  quit: "Quit",
  start: "Start server",
  stop: "Stop server",
  initError: "Tray unavailable",
  status: {
    stopped: "Stopped",
    starting: "Starting",
    loading: "Loading",
    ready: "Ready",
    busy: "Busy",
    stopping: "Stopping",
    restarting: "Restarting",
    crashed: "Crashed",
  },
};

describe("system tray server actions", () => {
  it("offers start after the process has stopped or crashed", () => {
    expect(getTrayServerPresentation("stopped", labels)).toEqual({
      statusText: "Stopped",
      actionText: "Start server",
      actionEnabled: true,
    });
    expect(getTrayServerPresentation("crashed", labels).actionText).toBe("Start server");
  });

  it("offers stop while the server is running", () => {
    expect(getTrayServerPresentation("ready", labels)).toEqual({
      statusText: "Ready",
      actionText: "Stop server",
      actionEnabled: true,
    });
    expect(getTrayServerPresentation("busy", labels).actionText).toBe("Stop server");
  });

  it("disables toggle actions while the process is transitioning", () => {
    for (const state of ["starting", "loading", "stopping", "restarting"] as const) {
      expect(getTrayServerPresentation(state, labels).actionEnabled).toBe(false);
    }
  });
});
