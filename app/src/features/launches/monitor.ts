import type { LogLine, RunLogEvent, RunStateEvent, ServerState } from "../../types/runtime";
import { subscribeLogs, subscribeRunLogs, subscribeRunState, subscribeServerState } from "../../services/tauri";

export interface RunMonitorCallbacks {
  intervalMs: number;
  refresh: () => Promise<void>;
  onLog: (line: LogLine) => void;
  onState: (state: ServerState) => void;
  onRunLog: (event: RunLogEvent) => void;
  onRunState: (event: RunStateEvent) => void;
}

/** Owns runtime polling and event subscriptions so the app shell only installs one monitor. */
export function startRunMonitor(callbacks: RunMonitorCallbacks): () => void {
  let disposed = false;
  const unlisten: (() => void)[] = [];
  const install = async () => {
    const listeners = await Promise.all([
      subscribeRunLogs(callbacks.onRunLog),
      subscribeRunState(callbacks.onRunState),
      subscribeLogs(callbacks.onLog),
      subscribeServerState(callbacks.onState),
    ]);
    if (disposed) listeners.forEach(off => off());
    else unlisten.push(...listeners);
  };
  void install().catch(console.error);
  const refresh = () => { void callbacks.refresh().catch(console.error); };
  refresh();
  const timer = window.setInterval(refresh, Math.max(500, callbacks.intervalMs));
  return () => {
    disposed = true;
    window.clearInterval(timer);
    unlisten.splice(0).forEach(off => off());
  };
}
