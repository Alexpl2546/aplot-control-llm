import { create } from 'zustand';
import { isTauri } from '../../services/tauri';
import { hostSnapshot, sendHostTask, subscribeHost, type HostSend, type HostSnapshot, type HostStreamMessage } from '../../services/agentTasks';
import { EMPTY_AGENT, useAgentStore, type AgentThread } from './store';
import { applyHostEvent, clientFields, projectTask, type HostEvent } from './taskProjection';

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

export const hostOwns = (runtime?: string) => useHostTasks.getState().runtimes.includes(runtime ?? 'hermes');

export async function loadHostTasks(): Promise<HostSnapshot | undefined> {
  if (!isTauri()) return undefined;
  try { return await hostSnapshot(); } catch { return undefined; }
}

/** Builds window threads for host tasks from a snapshot plus the window's own fields. */
export function adoptHostSnapshot(snapshot: HostSnapshot, threads: Record<string, AgentThread>, tasks: { id: string; runtime?: string }[]): Record<string, AgentThread> {
  useHostTasks.setState({ runtimes: snapshot.hostRuntimes, cursor: snapshot.cursor });
  const views = new Map(snapshot.tasks.map(view => [view.id, view]));
  const next = { ...threads };
  for (const task of tasks) {
    if (!snapshot.hostRuntimes.includes(task.runtime ?? 'hermes')) continue;
    const local = threads[task.id] ?? EMPTY_AGENT;
    const base: AgentThread = { ...EMPTY_AGENT, ...clientFields(local), voiceStatus: 'idle' };
    const view = views.get(task.id);
    next[task.id] = view ? projectTask(view, base) : base;
  }
  return next;
}

function receive(message: HostStreamMessage) {
  if (message.type === 'resync') { void resync(); return; }
  const cursor = useHostTasks.getState().cursor;
  const fresh = message.events.filter(event => event.seq > cursor);
  if (!fresh.length) return;
  useAgentStore.setState(state => {
    const threads = { ...state.threads };
    for (const event of fresh) {
      const thread = threads[event.taskId] ?? EMPTY_AGENT;
      threads[event.taskId] = restoreFailedDraft(applyHostEvent(thread, event), event);
    }
    return { threads };
  });
  useHostTasks.setState({ cursor: fresh.at(-1)!.seq });
}

/** A message this window sent that could not start goes back into the composer, as before. */
function restoreFailedDraft(thread: AgentThread, event: HostEvent): AgentThread {
  if (event.kind !== 'turn.upsert') return thread;
  const turn = event.payload.turn;
  if (turn.status !== 'failed' || !turn.commandId || !sentCommands.delete(turn.commandId)) return thread;
  return { ...thread, draft: [turn.text, thread.draft].filter(Boolean).join('\n\n'), attachments: [...(turn.attachments ?? []), ...(thread.attachments ?? [])] };
}

async function resync() {
  const snapshot = await hostSnapshot().catch(() => undefined);
  if (!snapshot) return;
  const views = new Map(snapshot.tasks.map(view => [view.id, view]));
  useAgentStore.setState(state => ({ threads: Object.fromEntries(Object.entries(state.threads).map(([id, thread]) => {
    const view = views.get(id);
    return [id, view ? projectTask(view, { ...EMPTY_AGENT, ...clientFields(thread), voiceStatus: thread.voiceStatus }) : thread];
  })) }));
  useHostTasks.setState({ runtimes: snapshot.hostRuntimes, cursor: snapshot.cursor });
}

/** Follows the journal after the snapshot cursor. Called once per window load, after a snapshot. */
export async function followHostTasks() {
  if (following) return;
  following = true;
  try { await subscribeHost(useHostTasks.getState().cursor, receive); }
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
