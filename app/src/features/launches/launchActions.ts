import type { AppSettings } from "../../types/app";
import type { LaunchConfig } from "../../types/config";
import type { RunInfo, ServerState } from "../../types/runtime";

export type LaunchAction = "start" | "restart";
export interface LaunchActionState {
  selectedRunId?: string;
  config: LaunchConfig;
  settings: AppSettings;
  dirty: boolean;
  optimizerRunning: boolean;
  runBusyById: Record<string, boolean>;
  runtime: { state: ServerState };
  runs: { info: Pick<RunInfo, "runId" | "state" | "generation"> }[];
}
export interface LaunchIntent {
  action: LaunchAction;
  runId?: string;
  generation?: number;
  profileName: string;
  fingerprint: string;
  needsConfirmation: boolean;
}
export interface LaunchActionPort {
  read: () => LaunchActionState;
  start: (runId?: string) => Promise<void>;
  restart: (runId: string) => Promise<void>;
}

export class LaunchChangedError extends Error {
  constructor() { super("Launch target or draft changed; review the current parameters and try again."); }
}

const fingerprint = (state: LaunchActionState) => JSON.stringify([state.config, state.settings, state.dirty]);

/** Shared UI use case. Lifecycle and persistence remain owned by the existing run actions. */
export function planLaunchAction(state: LaunchActionState, action: LaunchAction, runId = state.selectedRunId): LaunchIntent | undefined {
  if (state.optimizerRunning || runId !== state.selectedRunId || state.runBusyById[runId ?? `profile:${state.config.profileId}`]) return;
  const run = state.runs.find(item => item.info.runId === runId);
  if (runId && !run) return;
  // A newly selected profile has no run yet; the compatibility runtime may still
  // describe the previously selected server and must not block a separate launch.
  const status = run?.info.state ?? "stopped";
  if (action === "restart" ? !run || !["ready", "busy"].includes(status) : !["stopped", "crashed"].includes(status)) return;
  return { action, runId, generation: run?.info.generation, profileName: state.config.profileName, fingerprint: fingerprint(state), needsConfirmation: state.dirty };
}

export async function executeLaunchIntent(port: LaunchActionPort, intent: LaunchIntent, confirmed = false) {
  if (intent.needsConfirmation && !confirmed) return;
  const current = planLaunchAction(port.read(), intent.action, intent.runId);
  if (!current || current.runId !== intent.runId || current.generation !== intent.generation || current.fingerprint !== intent.fingerprint) throw new LaunchChangedError();
  if (intent.action === "restart" && intent.runId) await port.restart(intent.runId);
  else await port.start(intent.runId);
}
