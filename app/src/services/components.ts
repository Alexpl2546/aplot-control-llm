import { invoke, isTauri } from "@tauri-apps/api/core";

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
export function isRemovedComponentPath(path: string, roots: string[]): boolean {
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  return Boolean(normalized) && roots.some(root => {
    const prefix = root.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
    return normalized === prefix || normalized.startsWith(`${prefix}\\`);
  });
}
