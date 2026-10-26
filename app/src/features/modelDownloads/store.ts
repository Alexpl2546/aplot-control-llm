import { create } from "zustand";
import { isTauri } from "../../services/tauri";
import { isDownloadTask } from "./rules";
import { cancelModelDownload, listModelDownloads, listenForModelDownloads, pauseModelDownload, removeModelDownloadPartial, resumeModelDownload } from "./service";
import type { DownloadTask } from "./types";

interface DownloadState {
  tasks: DownloadTask[];
  loading: boolean;
  initialized: boolean;
  error?: string;
  demoMode: boolean;
  refresh: () => Promise<void>;
  applyTask: (task: DownloadTask) => void;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  removePartial: (id: string) => Promise<void>;
}

export const useModelDownloadStore = create<DownloadState>((set, get) => ({
  tasks: [], loading: false, initialized: false, demoMode: !isTauri(),
  applyTask: task => set(state => {
    const current = state.tasks.find(item => item.id === task.id);
    if (current && task.sequence <= current.sequence) return {};
    return { tasks: [task, ...state.tasks.filter(item => item.id !== task.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }),
  refresh: async () => {
    set({ loading: true, error: undefined });
    try {
      const snapshot = await listModelDownloads();
      if (!Array.isArray(snapshot) || !snapshot.every(isDownloadTask)) throw new Error("Invalid model download snapshot.");
      set(state => {
        const fromSnapshot = new Map(snapshot.map(task => [task.id, task]));
        for (const task of state.tasks) {
          const listed = fromSnapshot.get(task.id);
          if (!listed || task.sequence > listed.sequence) fromSnapshot.set(task.id, task);
        }
        const tasks = [...fromSnapshot.values()];
        return { tasks: tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), initialized: true };
      });
    } catch (cause) { set({ error: String(cause), initialized: true }); }
    finally { set({ loading: false }); }
  },
  pause: async id => { try { get().applyTask(await pauseModelDownload(id)); set({ error: undefined }); } catch (cause) { set({ error: String(cause) }); } },
  resume: async id => { try { get().applyTask(await resumeModelDownload(id)); set({ error: undefined }); } catch (cause) { set({ error: String(cause) }); } },
  cancel: async id => { try { get().applyTask(await cancelModelDownload(id)); set({ error: undefined }); } catch (cause) { set({ error: String(cause) }); } },
  removePartial: async id => { try { get().applyTask(await removeModelDownloadPartial(id)); set({ error: undefined }); } catch (cause) { set({ error: String(cause) }); } },
}));

let monitorGeneration = 0;
export function startModelDownloadMonitor(): () => void {
  const generation = ++monitorGeneration;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    try {
      const stop = await listenForModelDownloads(task => {
        if (!disposed && generation === monitorGeneration) useModelDownloadStore.getState().applyTask(task);
      });
      if (disposed || generation !== monitorGeneration) { stop(); return; }
      unlisten = stop;
      await useModelDownloadStore.getState().refresh();
    } catch (cause) {
      if (!disposed && generation === monitorGeneration) useModelDownloadStore.setState({ error: String(cause), initialized: true });
    }
  })();
  return () => { disposed = true; unlisten?.(); };
}
