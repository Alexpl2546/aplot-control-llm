import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface InstalledModule {
  id: string;
  name: string;
  versions: string[];
  paths: string[];
  bytes: number;
  externalPath: string | null;
  blocked: string | null;
}
export interface ComponentMaintenanceState {
  root: string;
  uninstallerPath: string | null;
  modules: InstalledModule[];
}
export interface ComponentRemovalReport { removed: string[]; errors: string[] }

export function getComponentMaintenance(): Promise<ComponentMaintenanceState> {
  if (!isTauri()) return Promise.resolve({ root: "", uninstallerPath: null, modules: [] });
  return invoke("component_maintenance_state");
}
export function removeInstalledComponents(ids: string[]): Promise<ComponentRemovalReport> {
  return invoke("remove_components", { ids });
}
export function launchUninstaller(): Promise<void> {
  return invoke("launch_uninstaller");
}
export function openUninstallSettings(): Promise<void> {
  return invoke("open_uninstall_settings");
}
export interface ComponentUpdate {
  id: string;
  installedVersion: string | null;
  availableVersion: string;
  updateAvailable: boolean;
  downloadBytes: number | null;
  repository: string;
}
export interface ComponentUpdateState { reviewedAt: string; installerAvailable: boolean; components: ComponentUpdate[] }
export interface ComponentUpdateResult { id: string; previousVersion: string | null; version: string; path: string }
export interface ComponentUpdateProgress { id: string; stage: string; title: string; percent: number | null; downloaded: number | null; total: number | null }

/** Versions come from the catalog bundled with this Aplot release; new ones arrive with app updates. */
export function getComponentUpdates(): Promise<ComponentUpdateState> {
  if (!isTauri()) return Promise.resolve({ reviewedAt: "", installerAvailable: false, components: [] });
  return invoke("component_update_state");
}
export function updateComponent(id: string): Promise<ComponentUpdateResult> {
  return invoke("update_component", { id });
}
export function installComponent(id: string): Promise<ComponentUpdateResult> {
  return invoke("install_component", { id });
}
export function subscribeComponentUpdate(callback: (progress: ComponentUpdateProgress) => void): Promise<UnlistenFn> {
  return isTauri() ? listen<ComponentUpdateProgress>("components://update", event => callback(event.payload)) : Promise.resolve(() => undefined);
}
export function isRemovedComponentPath(path: string, roots: string[]): boolean {
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  return Boolean(normalized) && roots.some(root => {
    const prefix = root.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
    return normalized === prefix || normalized.startsWith(`${prefix}\\`);
  });
}
