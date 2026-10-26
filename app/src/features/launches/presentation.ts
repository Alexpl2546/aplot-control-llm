import type { RunInfo, RuntimeSnapshot, ServerState } from "../../types/runtime";

export interface RunPresentation { info: RunInfo; runtime: RuntimeSnapshot; }

export const isActive = (state: ServerState) => !["stopped", "crashed"].includes(state);
export const isWorking = (state: ServerState) => state === "ready" || state === "busy";
export const isTransition = (state: ServerState) => ["starting", "loading", "stopping", "restarting"].includes(state);

/** Stable across reordering, stop/start and selection changes; colors are presentation only. */
export function runColor(runId: string) {
  let hash = 0;
  for (const character of runId) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return `var(--run-${hash % 6 + 1})`;
}

export function portOf(endpoint: string) {
  try { return new URL(endpoint).port || ""; } catch { return ""; }
}
