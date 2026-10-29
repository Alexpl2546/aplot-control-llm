import { Channel, invoke } from '@tauri-apps/api/core';
import type { AccessMode, AgentAttachment } from '../features/agent/ioModel';
import type { HostEvent, HostTaskView } from '../features/agent/taskProjection';
import type { AgentFrame } from '../features/agent/store';

export interface HostSnapshot { cursor: number; hostRuntimes: string[]; tasks: HostTaskView[]; }
export type HostStreamMessage = { type: 'events'; events: HostEvent[] } | { type: 'resync' } | { type: 'transient'; taskId: string; frame: AgentFrame };
export interface HostTaskConfig { modelId?: string; connectionId?: string; reasoning?: string; accessMode?: AccessMode; language?: string; context?: string; skills?: string; runId?: string; generation?: number; }
export interface HostSend { commandId: string; taskId: string; runtime: string; text: string; attachments: AgentAttachment[]; config?: HostTaskConfig; }
export interface HostSendResult { commandId: string; taskId: string; turnId: string; status: string; aggregateRevision: number; }
export interface HostApprovalResult { status: string; alreadyResolved: boolean; delivery?: string; }

export const hostSnapshot = () => invoke<HostSnapshot>('agent_tasks_snapshot');
export async function subscribeHost(after: number, onMessage: (message: HostStreamMessage) => void) {
  const channel = new Channel<HostStreamMessage>(); channel.onmessage = onMessage;
  await invoke('agent_tasks_subscribe', { after, onEvent: channel });
}
export const sendHostTask = (request: HostSend) => invoke<HostSendResult>('agent_task_send', { request });
/** Opens the session without a turn (voice input). Returns its session handle. */
export const prepareHostTask = (taskId: string, runtime: string, config: HostTaskConfig) => invoke<string>('agent_task_prepare', { taskId, runtime, config });
export const resumeHostTask = (taskId: string) => invoke<void>('agent_task_resume', { taskId });
export const interruptHostTask = (taskId: string, close: boolean) => invoke<void>('agent_task_interrupt', { taskId, close });
export const cancelHostTurn = (taskId: string, turnId: string) => invoke<void>('agent_task_cancel_queued', { taskId, turnId });
export const resetHostTask = (taskId: string) => invoke<void>('agent_task_reset_session', { taskId });
export const setHostTaskAccess = (taskId: string, mode: AccessMode) => invoke<void>('agent_task_access', { taskId, mode });
export const resolveHostApproval = (approvalId: string, result: Record<string, unknown>) => invoke<HostApprovalResult>('agent_approval_resolve', { approvalId, result });
/** Hands a runtime back to the window path. The window must reload afterwards. */
export const rollbackHostRuntime = (runtime: string) => invoke<number>('agent_tasks_rollback', { runtime });
export const enableHostRuntime = (runtime: string) => invoke<number>('agent_tasks_enable', { runtime });
