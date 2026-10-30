import { create } from "zustand";
import { isTauri } from "./tauri";

/** The same options the system dialog took, so callers only swap the import. */
export interface PickerFilter { name: string; extensions: string[] }
export interface PickerOptions {
  directory?: boolean;
  multiple?: boolean;
  filters?: PickerFilter[];
  defaultPath?: string;
  title?: string;
  /** Save mode: pick a folder and type a file name. */
  save?: boolean;
}
type Result = string | string[] | null;
interface Request { id: number; options: PickerOptions; resolve: (value: Result) => void }
let nextId = 0;

/** One picker at a time; FilePickerHost (mounted in App) renders it. */
export const useFilePicker = create<{ request?: Request; finish: (value: Result) => void }>((set, get) => ({
  request: undefined,
  finish: value => { get().request?.resolve(value); set({ request: undefined }); },
}));

function ask(options: PickerOptions): Promise<Result> {
  if (!isTauri()) return Promise.resolve(null);
  // A second request replaces the first, which then resolves as cancelled.
  useFilePicker.getState().request?.resolve(null);
  return new Promise(resolve => useFilePicker.setState({ request: { id: ++nextId, options, resolve } }));
}

/** Aplot's own styled picker in place of `@tauri-apps/plugin-dialog`'s `open`. */
export const open = (options: Omit<PickerOptions, "save"> = {}) => ask(options);
/** …and in place of its `save`: resolves to the full path of the file to write. */
export const save = async (options: Omit<PickerOptions, "save" | "directory" | "multiple"> = {}) => {
  const value = await ask({ ...options, save: true });
  return typeof value === "string" ? value : null;
};

const LAST = "aplot.picker.last";
export function lastFolder(): string | undefined { try { return localStorage.getItem(LAST) ?? undefined; } catch { return undefined; } }
export function rememberFolder(path: string) { try { localStorage.setItem(LAST, path); } catch { /* this session only */ } }
