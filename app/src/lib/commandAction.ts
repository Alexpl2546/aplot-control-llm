import type { ServerState } from "../types/runtime";

export type CommandRunAction = "start" | "restart";

export function commandRunAction(state: ServerState): CommandRunAction {
  return state === "stopped" || state === "crashed" ? "start" : "restart";
}
