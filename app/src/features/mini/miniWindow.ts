import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../services/tauri";
import { useControlStore } from "../../store/control";
import { isActive } from "../launches/presentation";
import { stopRunWithUndo } from "../launches/stopWithUndo";
import { isSupportedProfileEngine, profileRunId } from "../launches/profiles";
import { useUiPrefs } from "../../lib/uiPrefs";

export const MINI_LABEL = "mini";
export interface MiniRun { runId: string; name: string; index: number; state: string; tps: number; managed: boolean; endpoint: string; model?: string; vramGiB?: number; }
export interface MiniProfile { id: string; name: string; running: boolean; }
export interface MiniState { runs: MiniRun[]; profiles: MiniProfile[]; selectedRunId?: string; theme: string; language: string; lightMode: boolean; }
export type MiniCommand = { action: "start" | "stop" | "restart" | "select"; runId: string } | { action: "launch"; profileId: string } | { action: "focus" } | { action: "ready" } | { action: "lightMode"; on: boolean };

function snapshot(): MiniState {
  const state = useControlStore.getState();
  const dark = state.settings.theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : state.settings.theme === "dark";
  return {
    runs: state.runs.map((run, index) => {
      const vram = run.runtime.processMemory?.vramMiB;
      return { runId: run.info.runId, name: run.info.name, index, state: run.info.state, tps: run.runtime.generationTps || 0, managed: run.info.managed, endpoint: run.info.endpoint, model: run.runtime.modelName || undefined, vramGiB: typeof vram === "number" ? vram / 1024 : undefined };
    }),
    profiles: state.profiles.filter(profile => !profile.unsupportedEngine && isSupportedProfileEngine(profile.config.engine ?? "llama_cpp")).map(profile => ({
      id: profile.id, name: profile.name,
      running: state.runs.some(run => run.info.runId === profileRunId(profile.id) && isActive(run.info.state)),
    })),
    lightMode: useUiPrefs.getState().lightMode,
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
  await openMiniWindow();
}

/** The control panel; in light mode it is the only window, so it stays in the taskbar. */
let opening: Promise<void> | undefined;
export function openMiniWindow(): Promise<void> {
  // Two quick calls must not race each other into two panels.
  return opening ??= createMiniWindow().finally(() => { opening = undefined; });
}
async function createMiniWindow() {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel(MINI_LABEL);
  if (existing) { await existing.show(); await existing.setFocus(); return; }
  const light = useUiPrefs.getState().lightMode;
  const window = new WebviewWindow(MINI_LABEL, {
    url: "index.html?mini=1",
    title: "Aplot",
    width: 380, height: 320, minWidth: 300, minHeight: 140,
    resizable: true, decorations: false, transparent: true, shadow: false,
    alwaysOnTop: !light, skipTaskbar: !light, focus: true,
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
  const schedule = () => { if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; push(); }, 500); };
  const unsubscribePrefs = useUiPrefs.subscribe(schedule);
  const unsubscribe = useControlStore.subscribe(schedule);
  let off: (() => void) | undefined, disposed = false;
  void listen<MiniCommand>("mini://command", ({ payload }) => {
    const control = useControlStore.getState();
    if (payload.action === "ready") { last = ""; push(); return; }
    if (payload.action === "focus") { void leaveLightMode(); return; }
    if (payload.action === "lightMode") { void (payload.on ? enterLightMode() : leaveLightMode()); return; }
    if (payload.action === "select") { control.selectRun(payload.runId); return; }
    if (payload.action === "launch") { void launchProfile(payload.profileId); return; }
    const run = control.runs.find(item => item.info.runId === payload.runId);
    if (!run?.info.managed) return;
    if (payload.action === "stop" && isActive(run.info.state)) void stopRunWithUndo(payload.runId);
    if (payload.action === "start" && !isActive(run.info.state)) void control.startManagedRun(payload.runId);
    if (payload.action === "restart" && isActive(run.info.state)) void control.restartManagedRun(payload.runId);
  }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(console.error);
  return () => { disposed = true; unsubscribe(); unsubscribePrefs(); off?.(); window.clearTimeout(timer); };
}

/** Starts a saved profile from the panel; a profile that already runs is only selected. */
async function launchProfile(profileId: string) {
  const control = useControlStore.getState();
  const running = control.runs.find(run => run.info.runId === profileRunId(profileId) && isActive(run.info.state));
  if (running) { control.selectRun(running.info.runId); return; }
  try {
    await control.selectProfile(profileId);
    await useControlStore.getState().startManagedRun(useControlStore.getState().selectedRunId);
  } catch (error) { control.notify("error", String(error)); }
}

/** Light mode: the panel takes over and the main window hides with nothing left to draw (see App). */
let enteredAt = 0;
/** The main window may still be taking focus right after it hides; that is not the user asking for it back. */
export const lightModeSettled = () => Date.now() - enteredAt > 1500;

/** Switches run one after another, so a double call (or on then off) never leaves two panels or a hidden app. */
let switching: Promise<void> = Promise.resolve();
const serial = (step: () => Promise<void>) => (switching = switching.then(step, step));
export const enterLightMode = () => serial(enterLight);
export const leaveLightMode = () => serial(leaveLight);

async function enterLight() {
  enteredAt = Date.now();
  useUiPrefs.getState().setLightMode(true);
  if (!isTauri()) return;
  // Reopen so the panel picks up its taskbar entry and drops always-on-top (unless it already is the light panel).
  const existing = await WebviewWindow.getByLabel(MINI_LABEL);
  if (existing && !(await existing.isAlwaysOnTop().catch(() => true))) { await getCurrentWindow().hide().catch(console.error); return; }
  await existing?.close();
  await openMiniWindow().catch(console.error);
  await getCurrentWindow().hide().catch(console.error);
}

async function leaveLight() {
  const wasLight = useUiPrefs.getState().lightMode;
  useUiPrefs.getState().setLightMode(false);
  if (!isTauri()) return;
  const main = getCurrentWindow();
  await main.show().then(() => main.unminimize()).then(() => main.setFocus()).catch(console.error);
  if (wasLight) await (await WebviewWindow.getByLabel(MINI_LABEL))?.close().catch(console.error);
}
