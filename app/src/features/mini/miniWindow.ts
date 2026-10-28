import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../services/tauri";
import { useControlStore } from "../../store/control";
import { isActive } from "../launches/presentation";
import { stopRunWithUndo } from "../launches/stopWithUndo";

export const MINI_LABEL = "mini";
export interface MiniRun { runId: string; name: string; index: number; state: string; tps: number; managed: boolean; }
export interface MiniState { runs: MiniRun[]; selectedRunId?: string; theme: string; language: string; }
export type MiniCommand = { action: "start" | "stop" | "select"; runId: string } | { action: "focus" } | { action: "ready" };

function snapshot(): MiniState {
  const state = useControlStore.getState();
  const dark = state.settings.theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : state.settings.theme === "dark";
  return {
    runs: state.runs.map((run, index) => ({ runId: run.info.runId, name: run.info.name, index, state: run.info.state, tps: run.runtime.generationTps || 0, managed: run.info.managed })),
    selectedRunId: state.selectedRunId,
    theme: dark ? "dark" : "light",
    language: state.settings.language,
  };
}

/** Opens or closes the always-on-top mini window (Ctrl+Shift+M). */
export async function toggleMiniWindow() {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel(MINI_LABEL);
  if (existing) { await existing.close(); return; }
  const window = new WebviewWindow(MINI_LABEL, {
    url: "index.html?mini=1",
    title: "Aplot mini",
    width: 330, height: 156, minWidth: 260, minHeight: 92,
    resizable: true, decorations: false, transparent: true, shadow: false,
    alwaysOnTop: true, skipTaskbar: true, focus: true,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once("tauri://created", () => resolve());
    void window.once("tauri://error", event => reject(new Error(String(event.payload))));
  });
}

/** Main-window side of the bridge: pushes a compact state to the mini window and executes its commands. */
export function startMiniBridge() {
  if (!isTauri()) return () => undefined;
  let last = "", timer: number | undefined;
  const push = () => {
    const payload = snapshot(), text = JSON.stringify(payload);
    if (text === last) return;
    last = text;
    void emitTo(MINI_LABEL, "mini://state", payload).catch(() => undefined);
  };
  const unsubscribe = useControlStore.subscribe(() => { if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; push(); }, 500); });
  let off: (() => void) | undefined, disposed = false;
  void listen<MiniCommand>("mini://command", ({ payload }) => {
    const control = useControlStore.getState();
    if (payload.action === "ready") { last = ""; push(); return; }
    if (payload.action === "focus") { const main = getCurrentWindow(); void main.show().then(() => main.unminimize()).then(() => main.setFocus()).catch(console.error); return; }
    if (payload.action === "select") { control.selectRun(payload.runId); return; }
    const run = control.runs.find(item => item.info.runId === payload.runId);
    if (!run?.info.managed) return;
    if (payload.action === "stop" && isActive(run.info.state)) void stopRunWithUndo(payload.runId);
    if (payload.action === "start" && !isActive(run.info.state)) void control.startManagedRun(payload.runId);
  }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(console.error);
  return () => { disposed = true; unsubscribe(); off?.(); window.clearTimeout(timer); };
}
