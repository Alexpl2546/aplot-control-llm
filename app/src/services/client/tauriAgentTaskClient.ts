import { Channel, invoke } from '@tauri-apps/api/core';
import type { AplotClient, AgentTaskClient, HostApprovalResult, HostControlResult, HostFork, HostReview, HostSend, HostSendResult, HostSnapshot, HostSteer, HostStreamMessage, HostTaskConfig } from './agentTaskClient';
import type { AccessMode } from '../../features/agent/ioModel';

const tasks: AgentTaskClient = {
  snapshot: () => invoke<HostSnapshot>('agent_tasks_snapshot'),
  async subscribe(after, onMessage) {
    const channel = new Channel<HostStreamMessage>();
    channel.onmessage = onMessage;
    await invoke('agent_tasks_subscribe', { after, onEvent: channel });
  },
  send: (request: HostSend) => invoke<HostSendResult>('agent_task_send', { request }),
  steer: (request: HostSteer) => invoke<HostControlResult>('agent_task_steer', { request }),
  review: (request: HostReview) => invoke<HostControlResult>('agent_task_review', { request }),
  fork: (request: HostFork) => invoke<HostControlResult>('agent_task_fork', { request }),
  prepare: (taskId: string, runtime: string, config: HostTaskConfig) => invoke<string>('agent_task_prepare', { taskId, runtime, config }),
  resume: (taskId: string) => invoke<void>('agent_task_resume', { taskId }),
  interrupt: (taskId: string, close: boolean) => invoke<void>('agent_task_interrupt', { taskId, close }),
  cancelTurn: (taskId: string, turnId: string) => invoke<void>('agent_task_cancel_queued', { taskId, turnId }),
  reset: (taskId: string) => invoke<void>('agent_task_reset_session', { taskId }),
  setAccess: (taskId: string, mode: AccessMode) => invoke<void>('agent_task_access', { taskId, mode }),
  resolveApproval: (approvalId: string, result: Record<string, unknown>) => invoke<HostApprovalResult>('agent_approval_resolve', { approvalId, result }),
  rollbackRuntime: (runtime: string) => invoke<number>('agent_tasks_rollback', { runtime }),
  enableRuntime: (runtime: string) => invoke<number>('agent_tasks_enable', { runtime }),
};

/** The shipped application client currently uses the native Tauri host. */
export const tauriAplotClient: AplotClient = { agentTasks: tasks };
