import { create } from "zustand";
import { getComponentMaintenance, getComponentUpdates, installComponent, subscribeComponentUpdate, updateComponent, type ComponentMaintenanceState, type ComponentUpdateProgress, type ComponentUpdateState } from "../../services/components";
import { getSettings } from "../../services/tauri";
import { useControlStore } from "../../store/control";
import { refreshOpenAi } from "../../features/openai/store";

export type JobMode = "install" | "update";
interface ComponentJobs {
  active: string | null;
  mode: JobMode | null;
  progress: ComponentUpdateProgress | null;
  /** Reported on the card or row where the user started it. */
  failed: { id: string; error: string; mode: JobMode } | null;
  finished: string[];
  finishedMode: JobMode;
  /** Bumped after every run so views reload what is installed. */
  revision: number;
  catalog: ComponentUpdateState | null;
  /** Last component snapshot: the tab shows it at once while a fresh one is measured. */
  maintenance: ComponentMaintenanceState | null;
}

/** Install and update runs live outside the settings tabs, so progress survives switching tabs. */
export const useComponentJobs = create<ComponentJobs>(() => ({ active: null, mode: null, progress: null, failed: null, finished: [], finishedMode: "update", revision: 0, catalog: null, maintenance: null }));

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  void subscribeComponentUpdate(progress => useComponentJobs.setState(state => state.active === progress.id ? { progress } : {}));
}

export async function loadComponentCatalog() {
  const catalog = await getComponentUpdates().catch(() => null);
  useComponentJobs.setState({ catalog });
  return catalog;
}

let measuring: Promise<ComponentMaintenanceState> | null = null;
/** Measuring sizes walks every file; concurrent callers share one walk. */
export function loadComponentMaintenance() {
  measuring ??= getComponentMaintenance()
    .then(maintenance => { useComponentJobs.setState({ maintenance }); return maintenance; })
    .finally(() => { measuring = null; });
  return measuring;
}

// One at a time: the installer holds the component store lock for the whole run.
export async function runComponentJobs(ids: string[], mode: JobMode) {
  if (useComponentJobs.getState().active || !ids.length) return;
  listenOnce();
  useComponentJobs.setState({ failed: null, finished: [] });
  const finished: string[] = [];
  try {
    for (const id of ids) {
      useComponentJobs.setState({ active: id, mode, progress: null });
      await (mode === "install" ? installComponent(id) : updateComponent(id));
      finished.push(id);
    }
  } catch (reason) {
    useComponentJobs.setState(state => ({ failed: { id: state.active ?? "", error: String(reason), mode } }));
  } finally {
    if (finished.length) {
      // The settings loader points engine paths at new installations; agents look up their programs again.
      try {
        useControlStore.setState({ settings: await getSettings() });
        await useControlStore.getState().refreshAvailableEngines();
        await refreshOpenAi(true);
      } catch { /* reloaded on next start */ }
    }
    useComponentJobs.setState(state => ({ active: null, mode: null, progress: null, finished, finishedMode: mode, revision: state.revision + 1 }));
    void loadComponentCatalog();
  }
}

/** Short user-facing reason for installer and maintenance errors (keys under components.*). */
export function componentErrorKey(text: string) {
  return /Stop (the )?Strata|Strata engine update is in progress/.test(text) ? "components.update.strataRunning"
    : text.includes("installer-missing") ? "components.update.installerMissing"
    : text.includes("component-update-failed") ? "components.update.failed"
    : text.includes("process-active") ? "components.active"
    : text.includes("python-in-use") ? "components.pythonNeeded"
    : text.includes("maintenance-busy") ? "components.locked"
    : text.includes("link-protected") ? "components.links" : "components.failed";
}
