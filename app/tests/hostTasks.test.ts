import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  hostSnapshot: vi.fn(), subscribeHost: vi.fn(), sendHostTask: vi.fn(), resumeHostTask: vi.fn(), interruptHostTask: vi.fn(),
  cancelHostTurn: vi.fn(), resetHostTask: vi.fn(), setHostTaskAccess: vi.fn(), resolveHostApproval: vi.fn(),
}));
const transport = vi.hoisted(() => ({ startAgent: vi.fn(), promptAgent: vi.fn(), stopAgent: vi.fn(), respondAgent: vi.fn(), agentVoice: vi.fn() }));
vi.mock('../src/services/agentTasks', () => host);
vi.mock('../src/services/agent', () => transport);
vi.mock('../src/services/agentWorkspace', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(async (_data, revision) => revision + 1), validateWorkspaceFolder: vi.fn() }));
import { EMPTY_AGENT, useAgentStore, type AgentThread } from '../src/features/agent/store';
import { applyHostEvent, projectTask, type HostEvent, type HostTaskView } from '../src/features/agent/taskProjection';
import { adoptHostSnapshot, followHostTasks, sendHostMessage, useHostTasks } from '../src/features/agent/hostTasks';
import { answerAgent, enqueueAgent, interruptAgent, sendAgent } from '../src/features/agent/generation';
import { useWorkspaceStore, workspaceSnapshot } from '../src/features/agent/workspace';

const state = { pending: true, starting: false, ended: false, stopped: false, error: '', live: true, nativeSessionId: 'thread-1', nativeConnectionId: 'c1', children: [] };
const view: HostTaskView = { id: 'task', runtime: 'codex', revision: 9, state,
  messages: [{ id: 'u1', kind: 'user', text: 'hi' }, { id: 'a1', kind: 'assistant', text: 'work' }],
  turns: [{ id: 'run', taskId: 'task', status: 'running', messageId: 'u1', text: 'hi' }, { id: 'next', taskId: 'task', status: 'queued', messageId: 'u2', text: 'then this', time: 3 }],
  approvals: [{ id: 'ap', taskId: 'task', method: 'approval', params: { command: 'cargo test' }, status: 'pending' }] };
const event = (seq: number, rest: Omit<HostEvent, 'seq' | 'taskId' | 'revision' | 'at'>) => ({ seq, taskId: 'task', revision: seq, at: '', ...rest }) as HostEvent;
const target = { runId: '', generation: 0, language: 'en' };

beforeEach(() => {
  vi.resetAllMocks();
  useHostTasks.setState({ runtimes: ['codex'], cursor: 0 });
  useWorkspaceStore.setState({ ready: false, projects: [{ id: 'p', name: 'p', path: 'C:\\work', skills: '', createdAt: 0 }],
    tasks: [{ id: 'task', projectId: 'p', title: 'T', runtime: 'codex', cloudModel: 'gpt', connectionId: 'c1', createdAt: 0, updatedAt: 0, archived: false, unread: false },
      { id: 'local', projectId: 'p', title: 'H', createdAt: 0, updatedAt: 0, archived: false, unread: false }] });
  useAgentStore.setState({ threads: {} });
});

describe('host task projection', () => {
  it('shows host history, queue and pending approval while keeping the window draft', () => {
    const thread = projectTask(view, { ...EMPTY_AGENT, draft: 'typing' });
    expect(thread.id).toBe('host:task');
    expect(thread.entries.map(e => e.id)).toEqual(['u1', 'a1']);
    expect(thread.queue).toEqual([{ id: 'next', text: 'then this', attachments: undefined, time: 3 }]);
    expect(thread.requests).toEqual([{ id: 'ap', method: 'approval', params: { command: 'cargo test' } }]);
    expect(thread).toMatchObject({ pending: true, draft: 'typing', nativeRuntime: 'codex', nativeSessionId: 'thread-1' });
  });
  it('applies streamed appends, tails tool output and removes answered approvals', () => {
    let thread = projectTask(view, EMPTY_AGENT);
    thread = applyHostEvent(thread, event(1, { kind: 'message.append', payload: { id: 'a1', text: 'ing', reasoning: 'why' } }));
    expect(thread.entries[1]).toMatchObject({ text: 'working', reasoning: 'why' });
    thread = applyHostEvent(thread, event(2, { kind: 'message.upsert', payload: { message: { id: 't', kind: 'tool', text: 'abc' } } }));
    thread = applyHostEvent(thread, event(3, { kind: 'message.append', payload: { id: 't', text: 'def', reasoning: '', limit: 4 } }));
    expect(thread.entries[2]!.text).toBe('cdef');
    thread = applyHostEvent(thread, event(4, { kind: 'approval.upsert', payload: { approval: { ...view.approvals[0]!, status: 'approved' } } }));
    expect(thread.requests).toEqual([]);
    thread = applyHostEvent(thread, event(5, { kind: 'turn.upsert', payload: { turn: { ...view.turns[1]!, status: 'running' } } }));
    expect(thread.queue).toEqual([]);
    thread = applyHostEvent(thread, event(6, { kind: 'task.upsert', payload: { runtime: 'codex', state: { ...state, live: false, pending: false } } }));
    expect(thread).toMatchObject({ id: undefined, pending: false });
  });
});

describe('window reload with a host task', () => {
  it('rebuilds from the host snapshot instead of the saved thread and starts no agent', () => {
    const saved: Record<string, AgentThread> = { task: { ...EMPTY_AGENT, draft: 'unsent', entries: [{ id: 'stale', kind: 'user', text: 'old copy' }], ended: true }, local: { ...EMPTY_AGENT, draft: 'hermes' } };
    const threads = adoptHostSnapshot({ cursor: 40, hostRuntimes: ['codex'], tasks: [view] }, saved, useWorkspaceStore.getState().tasks);
    expect(threads.task!.entries.map(e => e.id)).toEqual(['u1', 'a1']);
    expect(threads.task!.requests).toHaveLength(1);
    expect(threads.task).toMatchObject({ draft: 'unsent', ended: false, pending: true });
    expect(threads.local).toBe(saved.local);
    expect(useHostTasks.getState().cursor).toBe(40);
    expect(transport.startAgent).not.toHaveBeenCalled();
  });
  it('follows the journal after the snapshot cursor and ignores replayed events', async () => {
    useAgentStore.setState({ threads: { task: projectTask(view, EMPTY_AGENT) } });
    useHostTasks.setState({ cursor: 10 });
    let receive!: (message: unknown) => void;
    host.subscribeHost.mockImplementation(async (_after, onMessage) => { receive = onMessage; });
    await followHostTasks();
    expect(host.subscribeHost.mock.calls[0]![0]).toBe(10);
    receive({ type: 'events', events: [event(9, { kind: 'message.append', payload: { id: 'a1', text: ' twice', reasoning: '' } }), event(11, { kind: 'message.append', payload: { id: 'a1', text: '!', reasoning: '' } })] });
    expect(useAgentStore.getState().threads.task!.entries[1]!.text).toBe('work!');
    expect(useHostTasks.getState().cursor).toBe(11);
  });
  it('keeps only window fields of host tasks in the saved workspace', () => {
    useAgentStore.setState({ threads: { task: projectTask(view, { ...EMPTY_AGENT, draft: 'unsent' }), local: { ...EMPTY_AGENT, entries: [{ id: 'h', kind: 'user', text: 'hermes' }] } } });
    const threads = workspaceSnapshot().threads as Record<string, Partial<AgentThread>>;
    expect(threads.task).toEqual(expect.objectContaining({ draft: 'unsent' }));
    expect(threads.task).not.toHaveProperty('entries');
    expect(threads.task).not.toHaveProperty('requests');
    expect(threads.local!.entries).toHaveLength(1);
  });
});

describe('commands for host tasks', () => {
  beforeEach(() => { useAgentStore.setState({ threads: { task: { ...EMPTY_AGENT, cwd: 'C:\\work', draft: 'build it', accessMode: 'manual' } } }); });
  it('sends a message as a command instead of starting a runtime in the window', async () => {
    host.sendHostTask.mockResolvedValue({ status: 'queued' });
    await sendAgent('task', target);
    expect(transport.startAgent).not.toHaveBeenCalled();
    const request = host.sendHostTask.mock.calls[0]![0];
    expect(request).toMatchObject({ taskId: 'task', runtime: 'codex', text: 'build it', config: { modelId: 'gpt', connectionId: 'c1', accessMode: 'manual', language: 'en' } });
    expect(request.commandId).toMatch(/[0-9a-f-]{36}/);
    expect(request).not.toHaveProperty('cwd');
    expect(useAgentStore.getState().threads.task!.draft).toBe('');
  });
  it('queues while a turn runs through the same command', async () => {
    host.sendHostTask.mockResolvedValue({ status: 'queued' });
    useAgentStore.getState().update('task', s => ({ ...s, pending: true }));
    enqueueAgent('task');
    await vi.waitFor(() => expect(host.sendHostTask).toHaveBeenCalledTimes(1));
    expect(useAgentStore.getState().threads.task!.queue ?? []).toEqual([]);
  });
  it('retries a lost reply with the same command ID', async () => {
    host.sendHostTask.mockRejectedValueOnce(new Error('IPC connection was lost')).mockResolvedValueOnce({ status: 'queued' });
    await sendHostMessage({ commandId: 'cmd', taskId: 'task', runtime: 'codex', text: 'x', attachments: [] });
    expect(host.sendHostTask.mock.calls.map(call => call[0].commandId)).toEqual(['cmd', 'cmd']);
  });
  it('returns the text to the composer when the host refuses it', async () => {
    host.sendHostTask.mockRejectedValue('queue-limit');
    await sendAgent('task', target);
    expect(host.sendHostTask).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().threads.task).toMatchObject({ draft: 'build it', error: 'agent-error' });
  });
  it('answers approvals and stops through the host', async () => {
    host.resolveHostApproval.mockResolvedValue({ status: 'approved', alreadyResolved: false });
    useAgentStore.getState().update('task', s => ({ ...s, requests: [{ id: 'ap', method: 'approval', params: {} }] }));
    expect(await answerAgent('task', 'ap', { choice: 'once' })).toBe(true);
    expect(host.resolveHostApproval).toHaveBeenCalledWith('ap', { choice: 'once' });
    expect(transport.respondAgent).not.toHaveBeenCalled();
    expect(await interruptAgent('task', true)).toBe(true);
    expect(host.interruptHostTask).toHaveBeenCalledWith('task', true);
    expect(transport.stopAgent).not.toHaveBeenCalled();
  });
});
