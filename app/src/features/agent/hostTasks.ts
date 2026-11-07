import { create } from 'zustand';
import { isTauri } from '../../services/tauri';
import { hostSnapshot, sendHostTask, subscribeHost, type HostSend, type HostSnapshot, type HostStreamMessage } from '../../services/agentTasks';
import { EMPTY_AGENT, agentFrame, useAgentStore, type AgentThread } from './store';
import { applyHostEvent, clientFields, projectTask, type HostEvent } from './taskProjection';
import type { AgentFrame } from './store';

/**
 * Agent tasks whose runtime is owned by the host process. The window renders a
 * snapshot and follows the host's event journal from a cursor; it never drives
 * these sessions itself, so a reload (Ctrl+R) neither loses state nor starts a
 * second agent. Drafts, attachments being composed and read state stay here.
 */
export const useHostTasks = create<{ runtimes: string[]; cursor: number }>(() => ({ runtimes: [], cursor: 0 }));
/** Commands sent from this window, so a failed turn returns its text to this composer only. */
const sentCommands = new Set<string>();
let following = false;
let refreshingSnapshot = false;
let snapshotRequestedAgain = false;
let snapshotPending = false;
let snapshotWork: Promise<void> | undefined;
let retrySnapshotTimer: ReturnType<typeof setTimeout> | undefined;
let minimumSnapshotCursor = 0;
const bufferedMessages: HostStreamMessage[] = [];
let applyHostSnapshot: ((snapshot: HostSnapshot) => Promise<void> | void) | undefined;

/** Workspace installs the merger so task rows and task projections adopt one snapshot together. */
export function setHostSnapshotHandler(handler: ((snapshot: HostSnapshot) => Promise<void> | void) | undefined) {
  applyHostSnapshot = handler;
}

export const hostOwns = (runtime?: string) => useHostTasks.getState().runtimes.includes(runtime ?? 'hermes');

export async function loadHostTasks(): Promise<HostSnapshot | undefined> {
  if (!isTauri()) return undefined;
  try { return await hostSnapshot(); } catch { return undefined; }
}

/** Builds window threads for host tasks from a snapshot plus the window's own fields. */
export function adoptHostSnapshot(snapshot: HostSnapshot, threads: Record<string, AgentThread>, tasks: { id: string; runtime?: string; cwd?: string; skills?: string; accessMode?: AgentThread['accessMode'] }[]): Record<string, AgentThread> {
  useHostTasks.setState({ runtimes: snapshot.hostRuntimes, cursor: snapshot.cursor });
  const views = new Map(snapshot.tasks.map(view => [view.id, view]));
  const next = { ...threads };
  for (const task of tasks) {
    if (!snapshot.hostRuntimes.includes(task.runtime ?? 'hermes')) continue;
    const local = threads[task.id] ?? EMPTY_AGENT;
    const base: AgentThread = { ...EMPTY_AGENT, ...clientFields(local),
      cwd: local.cwd || task.cwd || '', skills: local.skills || task.skills || '', accessMode: local.accessMode ?? task.accessMode,
      voiceStatus: 'idle' };
    const view = views.get(task.id);
    next[task.id] = view ? projectTask(view, base) : base;
  }
  return next;
}

let voiceSend: ((taskId: string) => void) | undefined;
/** Called when a transcript arrives that the person asked to send right away. */
export function onHostVoiceSend(send: (taskId: string) => void) { voiceSend = send; }

/** Voice capture changes only the window's draft and is never journaled. */
function receiveVoice(taskId: string, frame: AgentFrame) {
  const current = useAgentStore.getState().threads[taskId];
  if (!current) return;
  const sendAfter = frame.type === 'voice.transcript' && current.voiceSendAfter && !current.voiceDiscard && typeof frame.payload?.text === 'string' && !!frame.payload.text.trim() && !frame.payload.stop_phrase;
  useAgentStore.getState().update(taskId, thread => agentFrame(thread, frame));
  if (sendAfter) voiceSend?.(taskId);
}

/** Applies one message from the host stream (exported for tests). */
export function receiveHostMessage(message: HostStreamMessage) {
  if (message.type === 'transient') { receiveVoice(message.taskId, message.frame); return; }
  if (refreshingSnapshot || snapshotPending) {
    bufferedMessages.push(message);
    if (message.type === 'resync') snapshotRequestedAgain = true;
    return;
  }
  if (message.type === 'resync') { void refreshHostTasksSnapshot(); return; }
  if (applyEventMessage(message)) void refreshHostTasksSnapshot();
}

function applyEventMessage(message: Extract<HostStreamMessage, { type: 'events' }>): boolean {
  const cursor = useHostTasks.getState().cursor;
  const fresh = message.events.filter(event => event.seq > cursor);
  if (!fresh.length) return false;
  let workspaceChanged = false;
  useAgentStore.setState(state => {
    const threads = { ...state.threads };
    for (const event of fresh) {
      if (event.kind === 'workspace.changed') { workspaceChanged = true; continue; }
      if (event.kind === 'proposal.upsert') continue;
      const thread = threads[event.taskId] ?? EMPTY_AGENT;
      threads[event.taskId] = restoreFailedDraft(applyHostEvent(thread, event), event);
    }
    return { threads };
  });
  useHostTasks.setState({ cursor: Math.max(cursor, ...fresh.map(event => event.seq)) });
  return workspaceChanged;
}

/** A message this window sent that could not start goes back into the composer, as before. */
function restoreFailedDraft(thread: AgentThread, event: HostEvent): AgentThread {
  if (event.kind !== 'turn.upsert') return thread;
  const turn = event.payload.turn;
  if (turn.status === 'queued' || turn.status === 'running' || !turn.commandId || !sentCommands.delete(turn.commandId)) return thread;
  if (turn.status !== 'failed' || thread.entries.some(entry => entry.id === turn.messageId)) return thread;
  return { ...thread, draft: [turn.text, thread.draft].filter(Boolean).join('\n\n'), attachments: [...(turn.attachments ?? []), ...(thread.attachments ?? [])] };
}

/** Refreshes workspace metadata and host task projections against one atomic host snapshot. */
export async function refreshHostTasksSnapshot(): Promise<void> {
  minimumSnapshotCursor = Math.max(minimumSnapshotCursor, useHostTasks.getState().cursor);
  if (snapshotWork) {
    snapshotRequestedAgain = true;
    return snapshotWork;
  }
  refreshingSnapshot = true;
  snapshotWork = (async () => {
    do {
      snapshotRequestedAgain = false;
      const requiredCursor = Math.max(minimumSnapshotCursor, useHostTasks.getState().cursor);
      let snapshot: HostSnapshot | undefined;
      try {
        snapshot = await hostSnapshot();
        if (!snapshot || snapshot.cursor < requiredCursor) throw new Error('host-snapshot-stale');
        if (applyHostSnapshot) await applyHostSnapshot(snapshot);
        else {
          const adopted = adoptHostSnapshot(snapshot, useAgentStore.getState().threads, snapshot.tasks.map(view => ({ id: view.id, runtime: view.runtime })));
          useAgentStore.setState({ threads: adopted });
        }
      } catch {
        snapshotPending = true;
        if (!retrySnapshotTimer) retrySnapshotTimer = setTimeout(() => {
          retrySnapshotTimer = undefined;
          snapshotPending = false;
          void refreshHostTasksSnapshot();
        }, 500);
        return;
      }
      useHostTasks.setState({ runtimes: snapshot.hostRuntimes, cursor: snapshot.cursor });
      minimumSnapshotCursor = snapshot.cursor;
      snapshotPending = false;
      const buffered = bufferedMessages.splice(0);
      for (const message of buffered) {
        if (message.type === 'transient') { receiveVoice(message.taskId, message.frame); continue; }
        if (message.type === 'resync') { snapshotRequestedAgain = true; continue; }
        if (applyEventMessage(message)) snapshotRequestedAgain = true;
      }
    } while (snapshotRequestedAgain);
  })();
  try { await snapshotWork; }
  finally {
    snapshotWork = undefined;
    refreshingSnapshot = false;
  }
}

/** Follows the journal after the snapshot cursor. Called once per window load, after a snapshot. */
export async function followHostTasks() {
  if (following) return;
  following = true;
  try { await subscribeHost(useHostTasks.getState().cursor, receiveHostMessage); }
  catch { following = false; }
}

/** Stored before the reply; a retry with the same command ID returns the same turn. */
export async function sendHostMessage(request: HostSend) {
  sentCommands.add(request.commandId);
  try {
    try { return await sendHostTask(request); }
    catch (error) {
      // Domain errors are kebab-case codes; anything else may be a lost reply, so ask again.
      if (/^(Error: )?[a-z-]+$/.test(String(error))) throw error;
      return await sendHostTask(request);
    }
  } catch (error) { sentCommands.delete(request.commandId); throw error; }
}
