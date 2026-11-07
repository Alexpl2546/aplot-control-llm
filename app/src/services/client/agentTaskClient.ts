import type { AccessMode, AgentAttachment } from '../../features/agent/ioModel';
import type { AgentFrame } from '../../features/agent/store';
import type { HostEvent, HostTaskView } from '../../features/agent/taskProjection';

export interface WorkspaceEnvelope { version: number; revision: number; data: Record<string, unknown>; }
export interface HostSnapshot { cursor: number; hostRuntimes: string[]; tasks: HostTaskView[]; workspace?: WorkspaceEnvelope | null; }
export interface HostProposalRecord {
  proposalId: string; callerTaskId: string; callerGeneration: number; projectId: string;
  name: string; title: string; instructions: string;
  inherited: { runtime: string; model: string | null; connectionProfileId: string | null; binding: Record<string, unknown> | null; accessMode: string; reasoning: string | null; autoStartServer: boolean | null };
  status: string; agentId: string | null; createdAt: string;
}
export type HostStreamMessage = { type: 'events'; events: HostEvent[] } | { type: 'resync' } | { type: 'transient'; taskId: string; frame: AgentFrame };
export interface HostTaskConfig { modelId?: string; connectionId?: string; reasoning?: string; accessMode?: AccessMode; language?: string; context?: string; skills?: string; runId?: string; generation?: number; }
export interface HostSend { commandId: string; taskId: string; runtime: string; text: string; attachments: AgentAttachment[]; config?: HostTaskConfig; }
export interface HostSendResult { commandId: string; taskId: string; turnId: string; status: string; aggregateRevision: number; }
export interface HostSteer { commandId: string; taskId: string; expectedTurnId: string; expectedGeneration: number; text: string; }
export interface HostReview { commandId: string; taskId: string; expectedGeneration: number; }
export interface HostFork { commandId: string; sourceTaskId: string; taskId: string; expectedGeneration: number; }
export interface HostControlResult { commandId: string; taskId: string; sourceTaskId?: string; turnId?: string; reviewThreadId?: string; nativeSessionId?: string; status: string; error?: string; }
export interface HostApprovalResult { status: string; alreadyResolved: boolean; delivery?: string; }

/** Typed operations supported by any host task transport. This contract has no Tauri dependency. */
export interface AgentTaskClient {
  snapshot(): Promise<HostSnapshot>;
  /** Each successful call replaces this webview's prior host stream subscription; no cancel handle is exposed. */
  subscribe(after: number, onMessage: (message: HostStreamMessage) => void): Promise<void>;
  send(request: HostSend): Promise<HostSendResult>;
  steer(request: HostSteer): Promise<HostControlResult>;
  review(request: HostReview): Promise<HostControlResult>;
  fork(request: HostFork): Promise<HostControlResult>;
  prepare(taskId: string, runtime: string, config: HostTaskConfig): Promise<string>;
  resume(taskId: string): Promise<void>;
  interrupt(taskId: string, close: boolean): Promise<void>;
  cancelTurn(taskId: string, turnId: string): Promise<void>;
  reset(taskId: string): Promise<void>;
  setAccess(taskId: string, mode: AccessMode): Promise<void>;
  resolveApproval(approvalId: string, result: Record<string, unknown>): Promise<HostApprovalResult>;
  rollbackRuntime(runtime: string): Promise<number>;
  enableRuntime(runtime: string): Promise<number>;
}

/** Application transport boundary; future clients can implement typed APIs without exposing raw commands. */
export interface AplotClient {
  readonly agentTasks: AgentTaskClient;
}
