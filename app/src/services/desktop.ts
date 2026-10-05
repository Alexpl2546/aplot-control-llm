import { invoke, isTauri } from "@tauri-apps/api/core";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { defaultWindowIcon } from "@tauri-apps/api/app";
import type { AppSettings } from "../types/app";
import type { ServerState } from "../types/runtime";

export interface TrayLabels {
  show: string;
  quit: string;
  start: string;
  stop: string;
  status: Record<ServerState, string>;
  initError: string;
}

export interface TrayServerPresentation {
  statusText: string;
  actionText: string;
  actionEnabled: boolean;
}

export function getTrayServerPresentation(state: ServerState, labels: TrayLabels): TrayServerPresentation {
  const running = !["stopped", "crashed"].includes(state);
  return {
    statusText: labels.status[state],
    actionText: running ? labels.stop : labels.start,
    actionEnabled: !["starting", "loading", "stopping", "restarting"].includes(state),
  };
}

export async function syncWindowsAutostart(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  const autostart = await import("@tauri-apps/plugin-autostart");
  const current = await autostart.isEnabled();
  if (enabled && !current) await autostart.enable();
  if (!enabled && current) await autostart.disable();
}


export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (!isTauri()) { window.open(url, "_blank", "noopener,noreferrer"); return; }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function revealItem(path: string): Promise<void> {
  if (!path) return;
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/**
 * Installs desktop-only behavior while keeping the browser mock build usable.
 * Settings are read lazily so close/minimize-to-tray changes apply without
 * recreating the close handler.
 */
export async function installDesktopLifecycle(
  getSettings: () => AppSettings,
  getLabels: () => TrayLabels,
  getServerState: () => ServerState,
  toggleServer: () => Promise<void>,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;

  const { getCurrentWindow } = await import("@tauri-apps/api/window");

  const appWindow = getCurrentWindow();
  await TrayIcon.removeById("llama-control-main").catch(() => undefined);

  const showWindow = async () => {
    try {
      await appWindow.unminimize();
      await appWindow.show();
      await appWindow.setFocus();
    } catch (error) {
      console.error("Could not show the Aplot Control LLM window", error);
    }
  };

  const quitApp = async () => {
    try {
      await invoke("quit_app");
    } catch (error) {
      console.error("Could not quit Aplot Control LLM from the system tray", error);
    }
  };

  const labels = getLabels();
  const showItem = await MenuItem.new({ id: "show", text: labels.show, action: () => void showWindow() });
  const statusItem = await MenuItem.new({ id: "server-status", text: "", enabled: false });
  const serverItem = await MenuItem.new({ id: "server-toggle", text: labels.start, action: () => void toggleServer().catch(error => console.error("Could not toggle llama-server from the tray", error)) });
  const quitItem = await MenuItem.new({ id: "quit", text: labels.quit, action: () => void quitApp() });
  const menu = await Menu.new({ items: [showItem, statusItem, serverItem, quitItem] });

  const updateServerMenu = async () => {
    try {
      const labels = getLabels();
      const state = getServerState();
      const presentation = getTrayServerPresentation(state, labels);
      await showItem.setText(labels.show);
      await statusItem.setText(presentation.statusText);
      await serverItem.setText(presentation.actionText);
      await serverItem.setEnabled(presentation.actionEnabled);
      await quitItem.setText(labels.quit);
    } catch (error) {
      console.error("Could not refresh the Aplot Control LLM tray menu", error);
    }
  };
  await updateServerMenu();

  const tray = await TrayIcon.new({
    id: "llama-control-main",
    icon: (await defaultWindowIcon()) ?? undefined,
    menu,
    tooltip: "Aplot Control LLM",
    showMenuOnLeftClick: false,
    action: event => {
      if (event.type === "Click" && event.button === "Left" && event.buttonState === "Up") {
        void showWindow();
      }
    },
  });

  // Tauri does not expose a dedicated minimize-request event. A low-frequency
  // state check is sufficient here and avoids platform-specific Win32 hooks.
  const minimizeTimer = window.setInterval(() => {
    if (!getSettings().minimizeToTray) return;
    void (async () => {
      if (await appWindow.isMinimized()) {
        await appWindow.hide();
        await appWindow.unminimize();
      }
    })();
  }, 750);
  const statusTimer = window.setInterval(() => void updateServerMenu(), 1000);

  return () => {
    window.clearInterval(minimizeTimer);
    window.clearInterval(statusTimer);
    void tray.close().catch(error => console.error("Could not remove Aplot Control LLM tray icon", error));
    void menu.close().catch(error => console.error("Could not close Aplot Control LLM tray menu", error));
  };
}
