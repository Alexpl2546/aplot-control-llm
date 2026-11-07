import type { AccessMode } from '../features/agent/ioModel';
import { getAplotClient, getAplotClientSelection, isCurrentAplotClientSelection } from './client/selection';
import type { HostApprovalResult, HostControlResult, HostFork, HostReview, HostSend, HostSendResult, HostSnapshot, HostSteer, HostStreamMessage, HostTaskConfig } from './client/agentTaskClient';

export type { HostApprovalResult, HostControlResult, HostFork, HostReview, HostSend, HostSendResult, HostSnapshot, HostSteer, HostStreamMessage, HostTaskConfig } from './client/agentTaskClient';

export const hostSnapshot = () => getAplotClient().agentTasks.snapshot();
/** Stale callbacks are ignored after the selected client changes; the host owns stream replacement and cleanup. */
export async function subscribeHost(after: number, onMessage: (message: HostStreamMessage) => void): Promise<void> {
  const selection = getAplotClientSelection();
  let acceptingMessages = true;
  try {
    await selection.client.agentTasks.subscribe(after, message => {
      if (acceptingMessages && isCurrentAplotClientSelection(selection)) onMessage(message);
    });
  } catch (error) {
    // A failed attempt must not leave a callback capable of delivering late events;
    // callers can retry because this facade does not retain a global following flag.
    acceptingMessages = false;
    throw error;
  }
}
export const sendHostTask = (request: HostSend) => getAplotClient().agentTasks.send(request);

/** Steer an active Codex turn; a retry reuses Codex's clientUserMessageId. */
export async function steerHostTask(request: HostSteer) {
  const client = getAplotClient().agentTasks;
  try { return await client.steer(request); }
  catch (error) {
    // A lost reply is ambiguous. Reusing commandId is safe because the host
    // forwards it as app-server's idempotent clientUserMessageId.
    if (/^(Error: )?[a-z-]+$/.test(String(error)) && !/^(Error: )?timeout$/.test(String(error))) throw error;
    return await client.steer(request);
  }
}

/** Start a review on the task thread. This is deliberately not retried after an ambiguous reply. */
export const reviewHostTask = (request: HostReview) => getAplotClient().agentTasks.review(request);
/** Fork an idle Codex host thread into a saved child task with the same host bindings. */
export const forkHostTask = (request: HostFork) => getAplotClient().agentTasks.fork(request);
/** Opens the session without a turn (voice input). Returns its session handle. */
export const prepareHostTask = (taskId: string, runtime: string, config: HostTaskConfig) => getAplotClient().agentTasks.prepare(taskId, runtime, config);
export const resumeHostTask = (taskId: string) => getAplotClient().agentTasks.resume(taskId);
export const interruptHostTask = (taskId: string, close: boolean) => getAplotClient().agentTasks.interrupt(taskId, close);
export const cancelHostTurn = (taskId: string, turnId: string) => getAplotClient().agentTasks.cancelTurn(taskId, turnId);
export const resetHostTask = (taskId: string) => getAplotClient().agentTasks.reset(taskId);
export const setHostTaskAccess = (taskId: string, mode: AccessMode) => getAplotClient().agentTasks.setAccess(taskId, mode);
export const resolveHostApproval = (approvalId: string, result: Record<string, unknown>) => getAplotClient().agentTasks.resolveApproval(approvalId, result);
/** Hands a runtime back to the window path. The window must reload afterwards. */
export const rollbackHostRuntime = (runtime: string) => getAplotClient().agentTasks.rollbackRuntime(runtime);
export const enableHostRuntime = (runtime: string) => getAplotClient().agentTasks.enableRuntime(runtime);
