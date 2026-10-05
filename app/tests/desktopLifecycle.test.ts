import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopLifecycle, type TrayLabels } from "../src/services/desktop";
import { DEFAULT_SETTINGS } from "../src/types/app";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  getCurrentWindow: vi.fn(),
  items: new Map<string, { action?: () => void; setText: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> }>(),
  intervals: [] as Array<() => void>,
  trayOptions: undefined as undefined | { action?: (event: { type: string; button: string; buttonState: string }) => void },
  closeTray: vi.fn().mockResolvedValue(undefined),
  closeMenu: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/menu", () => ({
  MenuItem: {
    new: vi.fn(async (options: { id: string; text: string; action?: () => void }) => {
      const item = {
        action: options.action,
        setText: vi.fn().mockResolvedValue(undefined),
        setEnabled: vi.fn().mockResolvedValue(undefined),
      };
      mocks.items.set(options.id, item);
      return item;
    }),
  },
  Menu: { new: vi.fn(async () => ({ close: mocks.closeMenu })) },
}));

vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: {
    removeById: vi.fn().mockResolvedValue(undefined),
    new: vi.fn(async (options: typeof mocks.trayOptions) => {
      mocks.trayOptions = options;
      return { close: mocks.closeTray };
    }),
  },
}));

vi.mock("@tauri-apps/api/app", () => ({ defaultWindowIcon: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: mocks.getCurrentWindow }));

const labels: TrayLabels = {
  show: "Open Aplot Control LLM",
  quit: "Quit Aplot Control LLM",
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

const appWindow = {
  unminimize: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
  setFocus: vi.fn().mockResolvedValue(undefined),
  isMinimized: vi.fn().mockResolvedValue(false),
  hide: vi.fn().mockResolvedValue(undefined),
};

describe("desktop tray lifecycle", () => {
  beforeEach(() => {
    mocks.items.clear();
    mocks.intervals.length = 0;
    mocks.trayOptions = undefined;
    vi.clearAllMocks();
    mocks.getCurrentWindow.mockReturnValue(appWindow);
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => {
        mocks.intervals.push(callback);
        return mocks.intervals.length;
      },
      clearInterval: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("wires Open, Quit, and server toggle to the application actions", async () => {
    const toggleServer = vi.fn().mockResolvedValue(undefined);
    const dispose = await installDesktopLifecycle(
      () => ({ ...DEFAULT_SETTINGS, minimizeToTray: false }),
      () => labels,
      () => "stopped",
      toggleServer,
    );

    expect(mocks.items.has("show")).toBe(true);
    expect(mocks.items.has("quit")).toBe(true);
    expect(mocks.items.has("server-toggle")).toBe(true);

    mocks.items.get("show")?.action?.();
    mocks.items.get("quit")?.action?.();
    mocks.items.get("server-toggle")?.action?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(appWindow.unminimize).toHaveBeenCalledOnce();
    expect(appWindow.show).toHaveBeenCalledOnce();
    expect(appWindow.setFocus).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_app");
    expect(toggleServer).toHaveBeenCalledOnce();

    mocks.trayOptions?.action?.({ type: "Click", button: "Left", buttonState: "Up" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(appWindow.unminimize).toHaveBeenCalledTimes(2);

    dispose();
    expect(mocks.closeTray).toHaveBeenCalledOnce();
    expect(mocks.closeMenu).toHaveBeenCalledOnce();
  });
});
