import type { ServerState } from "../types/runtime";

/** A launch is eligible for recovery only after this exact managed process is healthy. */
export function shouldCommitReadyLaunch(
  state: ServerState,
  snapshotPid: number | undefined,
  launchedPid: number | undefined,
  launchAttempt: number,
  readyAttempt: number,
): boolean {
  return state === "ready"
    && snapshotPid !== undefined
    && launchedPid === snapshotPid
    && launchAttempt > readyAttempt;
}
