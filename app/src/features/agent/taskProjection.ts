import { readContext, type AgentAttachment } from './ioModel';
import type { AgentChild, AgentEntry, AgentQuestion, AgentThread, QueuedPrompt } from './store';

/** Runtime state owned by the host (`tasks::store::TaskState`). */
export interface HostTaskState { pending: boolean; starting: boolean; ended: boolean; stopped: boolean; error: string; ioError?: string; live: boolean; nativeSessionId?: string; nativeConnectionId?: string; actualModelId?: string; context?: unknown; children: AgentChild[]; }
export interface HostTurn { id: string; taskId: string; status: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled'; commandId?: string | null; messageId: string; text: string; attachments?: AgentAttachment[] | null; time?: number | null; error?: string | null; }
export interface HostApproval { id: string; taskId: string; method: 'approval' | 'clarify'; params: Record<string, unknown>; status: 'pending' | 'approved' | 'denied' | 'expired' | 'stale'; }
export interface HostTaskView { id: string; runtime: string; revision: number; state: HostTaskState; messages: AgentEntry[]; turns: HostTurn[]; approvals: HostApproval[]; }
export type HostEvent = { seq: number; taskId: string; revision: number; at: string } & (
  | { kind: 'task.upsert'; payload: { runtime: string; state: HostTaskState } }
  | { kind: 'message.upsert'; payload: { message: AgentEntry } }
  | { kind: 'message.append'; payload: { id: string; text: string; reasoning: string; limit?: number | null } }
  | { kind: 'message.remove'; payload: { id: string } }
  | { kind: 'turn.upsert'; payload: { turn: HostTurn } }
  | { kind: 'approval.upsert'; payload: { approval: HostApproval } });

const HOST_PREFIX = 'host:';
/** Session handle shown to the UI while the host has a live runtime session for the task. */
export const hostSessionId = (taskId: string) => HOST_PREFIX + taskId;
export const hostTaskOf = (sessionId?: string) => sessionId?.startsWith(HOST_PREFIX) ? sessionId.slice(HOST_PREFIX.length) : undefined;

/** What the window keeps for itself. Everything else of a host task comes from the host. */
export function clientFields(thread: AgentThread): Partial<AgentThread> {
  const { draft, attachments, cwd, skills, accessMode, appliedMemory } = thread;
  return { draft, attachments, cwd, skills, accessMode, appliedMemory };
}

function withState(thread: AgentThread, taskId: string, runtime: string, state: HostTaskState): AgentThread {
  return { ...thread, id: state.live ? hostSessionId(taskId) : undefined, pending: state.pending, starting: state.starting, ended: state.ended, stopped: state.stopped, error: state.error, ioError: state.ioError ?? (state.pending ? undefined : thread.ioError),
    nativeSessionId: state.nativeSessionId, nativeConnectionId: state.nativeConnectionId, nativeRuntime: state.nativeSessionId && (runtime === 'codex' || runtime === 'claude') ? runtime : undefined,
    actualModelId: state.actualModelId, context: state.context ? readContext(state.context) ?? thread.context : undefined, children: state.children, restored: false, cursor: undefined };
}
const queued = (turn: HostTurn): QueuedPrompt => ({ id: turn.id, text: turn.text, attachments: turn.attachments ?? undefined, time: turn.time ?? 0 });
const question = (approval: HostApproval): AgentQuestion => ({ id: approval.id, method: approval.method, params: approval.params });

export function projectTask(view: HostTaskView, base: AgentThread): AgentThread {
  return { ...withState(base, view.id, view.runtime, view.state), entries: view.messages,
    queue: view.turns.filter(turn => turn.status === 'queued').map(queued),
    requests: view.approvals.filter(approval => approval.status === 'pending').map(question) };
}

function tail(text: string, limit?: number | null) { return limit && text.length > limit ? text.slice(-limit) : text; }

export function applyHostEvent(thread: AgentThread, event: HostEvent): AgentThread {
  switch (event.kind) {
    case 'task.upsert': return withState(thread, event.taskId, event.payload.runtime, event.payload.state);
    case 'message.upsert': {
      const message = event.payload.message, index = thread.entries.findIndex(entry => entry.id === message.id);
      return { ...thread, entries: index < 0 ? [...thread.entries, message] : thread.entries.map((entry, at) => at === index ? message : entry) };
    }
    case 'message.append': {
      const { id, text, reasoning, limit } = event.payload;
      return { ...thread, entries: thread.entries.map(entry => entry.id !== id ? entry : { ...entry, text: tail(entry.text + text, limit), reasoning: reasoning ? (entry.reasoning ?? '') + reasoning : entry.reasoning }) };
    }
    case 'message.remove': return { ...thread, entries: thread.entries.filter(entry => entry.id !== event.payload.id) };
    case 'turn.upsert': {
      const turn = event.payload.turn, rest = (thread.queue ?? []).filter(item => item.id !== turn.id);
      return { ...thread, queue: turn.status === 'queued' ? [...rest, queued(turn)] : rest };
    }
    case 'approval.upsert': {
      const approval = event.payload.approval, rest = thread.requests.filter(request => request.id !== approval.id);
      return { ...thread, requests: approval.status === 'pending' ? [...rest, question(approval)] : rest };
    }
  }
}
