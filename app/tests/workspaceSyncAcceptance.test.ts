import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  syncWorkspaceSnapshot: vi.fn(),
  validateWorkspaceFolder: vi.fn(),
  hostSnapshot: vi.fn(),
  subscribeHost: vi.fn(),
  resetHostTask: vi.fn(),
  sendHostTask: vi.fn(),
}));

vi.mock('../src/services/agentWorkspace', () => ({
  loadWorkspace: bridge.loadWorkspace,
  saveWorkspace: bridge.saveWorkspace,
  syncWorkspaceSnapshot: bridge.syncWorkspaceSnapshot,
  validateWorkspaceFolder: bridge.validateWorkspaceFolder,
}));
vi.mock('../src/services/agentTasks', () => ({
  hostSnapshot: bridge.hostSnapshot,
  subscribeHost: bridge.subscribeHost,
  resetHostTask: bridge.resetHostTask,
  sendHostTask: bridge.sendHostTask,
}));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));

type WorkspaceData = {
  agentDirectoryVersion: number;
  builtinSeedVersion: number;
  templatesSeeded: number;
  presets: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  tasks: Array<Record<string, unknown> & { id: string; projectId: string; title: string }>;
  memory: Record<string, unknown>[];
  selectedProjectId: string;
  selectedTaskId: string;
  threads: Record<string, Record<string, unknown>>;
  mode: string;
};
type Envelope = { version: 2; revision: number; data: WorkspaceData };
type Snapshot = {
  cursor: number;
  hostRuntimes: string[];
  tasks: Array<{
    id: string;
    runtime: string;
    revision: number;
    state: Record<string, unknown>;
    messages: Array<Record<string, unknown>>;
    turns: Array<Record<string, unknown>>;
    approvals: Array<Record<string, unknown>>;
  }>;
  workspace: Envelope | null;
};
type Subscription = { after: number; receive: (message: unknown) => void };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function initialEnvelope(): Envelope {
  return {
    version: 2,
    revision: 7,
    data: {
      agentDirectoryVersion: 1,
      builtinSeedVersion: 3,
      templatesSeeded: 1,
      presets: [{
        id: 'parent-preset', name: 'Parent agent', runtime: 'codex',
        accessMode: 'restricted', instructions: 'Keep this parent configuration',
        projectIds: ['project-1'],
      }, {
        id: 'reviewer-preset', name: 'Reviewer', runtime: 'codex',
        accessMode: 'restricted', instructions: 'Keep the existing collaborator',
        projectIds: ['project-1'],
      }, {
        id: 'child-preset', name: 'Child agent', runtime: 'codex',
        accessMode: 'restricted', instructions: 'Child instructions',
        projectIds: ['project-1'],
      }],
      projects: [{
        id: 'project-1', name: 'Parent project', path: 'C:\\work\\parent', skills: 'project skill',
        createdAt: 10, instructions: 'Parent project instructions', knowledge: ['vault-1'],
      }],
      tasks: [{
        id: 'parent-task', projectId: 'project-1', title: 'Parent task', runtime: 'codex',
        createdAt: 11, updatedAt: 12, archived: false, unread: false,
        presetId: 'parent-preset', agentName: 'Parent agent',
        instructions: 'Preserve parent task instructions', collaboratorPresetIds: ['reviewer-preset'],
        accessMode: 'restricted', parentTaskId: undefined,
      }],
      memory: [{
        id: 'memory-1', projectId: 'project-1', category: 'decision',
        text: 'Parent decision', confirmed: true, updatedAt: 13,
      }],
      selectedProjectId: 'project-1',
      selectedTaskId: 'parent-task',
      threads: {
        'parent-task': {
          draft: 'window draft',
          attachments: [{ id: 'attachment-1', path: 'C:\\work\\notes.txt', name: 'notes.txt', size: 4, kind: 'file' }],
          cwd: 'C:\\work\\parent', skills: 'project skill', accessMode: 'restricted',
          appliedMemory: [{ id: 'memory-1', text: 'Parent decision', updatedAt: 13 }],
        },
      },
      mode: 'agent',
    },
  };
}

function hostView(taskId: string, messages: Array<Record<string, unknown>> = []) {
  return {
    id: taskId,
    runtime: 'codex',
    revision: 1,
    state: {
      pending: false, starting: false, ended: true, stopped: false,
      error: '', live: false, nativeSessionId: `native-${taskId}`, children: [],
    },
    messages,
    turns: [],
    approvals: [],
  };
}

function delegationEvents(lastSeq: number, revision: number) {
  const firstSeq = lastSeq - 3;
  return {
    type: 'events',
    events: [
      {
        seq: firstSeq, taskId: 'child-task', revision: firstSeq, at: `event-${firstSeq}`,
        kind: 'task.upsert', payload: { runtime: 'codex', state: {
          pending: false, starting: false, ended: false, stopped: false, error: '', live: false, children: [],
        } },
      },
      {
        seq: firstSeq + 1, taskId: 'child-task', revision: firstSeq + 1, at: `event-${firstSeq + 1}`,
        kind: 'message.upsert', payload: { message: { id: 'child-user', kind: 'user', text: 'Child task prompt' } },
      },
      {
        seq: firstSeq + 2, taskId: 'child-task', revision: firstSeq + 2, at: `event-${firstSeq + 2}`,
        kind: 'turn.upsert', payload: { turn: {
          id: 'child-turn', taskId: 'child-task', status: 'queued', messageId: 'child-user', text: 'Child task prompt', time: 20,
        } },
      },
      {
        seq: lastSeq, taskId: 'parent-task', revision: lastSeq, at: `event-${lastSeq}`,
        kind: 'workspace.changed', payload: { revision, childTaskId: 'child-task' },
      },
    ],
  };
}

function taskMessage(seq: number, id: string) {
  return {
    type: 'events',
    events: [{
      seq, taskId: 'parent-task', revision: seq, at: `event-${seq}`,
      kind: 'message.upsert', payload: { message: { id, kind: 'assistant', text: 'arrived after snapshot' } },
    }],
  };
}

function proposalEvent(seq: number) {
  return {
    type: 'events',
    events: [{
      seq, taskId: 'parent-task', revision: seq, at: `event-${seq}`,
      kind: 'proposal.upsert', payload: { proposal: { id: 'proposal-1', status: 'pending' } },
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('workspace host synchronization acceptance', () => {
  let envelope: Envelope;
  let cursor: number;
  let subscriptions: Subscription[];
  let receive: ((message: unknown) => void) | undefined;
  let workspace: typeof import('../src/features/agent/workspace');
  let hostTasks: typeof import('../src/features/agent/hostTasks');
  let agentStore: typeof import('../src/features/agent/store');

  function snapshot(): Snapshot {
    const taskViews = envelope.data.tasks
      .filter(task => task.runtime === 'codex')
      .map(task => hostView(task.id, task.id === 'child-task'
        ? [{ id: 'child-user', kind: 'user', text: 'Child task prompt' }]
        : [{ id: 'parent-user', kind: 'user', text: 'Parent history' }]));
    return {
      cursor,
      hostRuntimes: ['codex'],
      tasks: taskViews,
      workspace: clone(envelope),
    };
  }

  function compareAndSwap(data: Record<string, unknown>, expectedRevision: number): number {
    if (expectedRevision !== envelope.revision) throw new Error('workspace-conflict');
    envelope = {
      version: 2,
      revision: expectedRevision + 1,
      data: clone(data) as WorkspaceData,
    };
    return envelope.revision;
  }

  function hostAddsChild() {
    const data = clone(envelope.data);
    data.tasks.push({
      id: 'child-task', projectId: 'project-1', title: 'Delegated child', runtime: 'codex',
      createdAt: 20, updatedAt: 20, archived: false, unread: false,
      parentTaskId: 'parent-task', presetId: 'child-preset', agentName: 'Child agent', accessMode: 'restricted',
      instructions: 'Child instructions',
    });
    const parent = data.tasks.find(task => task.id === 'parent-task')!;
    parent.collaboratorPresetIds = ['reviewer-preset', 'child-preset'];
    envelope = { version: 2, revision: envelope.revision + 1, data };
    cursor += 4;
    return envelope.revision;
  }

  function emit(message: unknown) {
    const callback = receive ?? subscriptions.at(-1)?.receive;
    if (!callback) throw new Error('Host event subscription was not installed');
    callback(message);
  }

  async function start() {
    vi.resetModules();
    envelope = initialEnvelope();
    cursor = 40;
    subscriptions = [];
    receive = undefined;

    bridge.loadWorkspace.mockImplementation(async () => clone(envelope));
    bridge.saveWorkspace.mockImplementation(async (data: Record<string, unknown>, revision: number) => compareAndSwap(data, revision));
    bridge.syncWorkspaceSnapshot.mockImplementation(async () => clone(envelope));
    bridge.hostSnapshot.mockImplementation(async () => clone(snapshot()));
    bridge.subscribeHost.mockImplementation(async (after: number, onMessage: (message: unknown) => void) => {
      subscriptions.push({ after, receive: onMessage });
      receive = onMessage;
    });
    bridge.resetHostTask.mockResolvedValue(undefined);
    bridge.validateWorkspaceFolder.mockResolvedValue('C:\\work\\parent');

    [workspace, hostTasks, agentStore] = await Promise.all([
      import('../src/features/agent/workspace'),
      import('../src/features/agent/hostTasks'),
      import('../src/features/agent/store'),
    ]);
    await workspace.initializeWorkspace();
    await workspace.flushWorkspace();
    await Promise.resolve();
    if (!receive) throw new Error('Host subscription did not initialize');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps the renderer-first CAS edit when a later host transaction adds a child', async () => {
    await start();
    workspace.editTask('parent-task', { title: 'Locally renamed parent' });
    await workspace.flushWorkspace();
    const childRevision = hostAddsChild();
    emit(delegationEvents(cursor, childRevision));
    await settle(() => workspace.useWorkspaceStore.getState().tasks.some(task => task.id === 'child-task'), 'child task from host snapshot');
    await settle(() => !!agentStore.useAgentStore.getState().threads['child-task'], 'child host task projection');

    const state = workspace.useWorkspaceStore.getState();
    expect(state.tasks.find(task => task.id === 'parent-task')).toMatchObject({
      title: 'Locally renamed parent', presetId: 'parent-preset', agentName: 'Parent agent',
      instructions: 'Preserve parent task instructions', collaboratorPresetIds: ['reviewer-preset', 'child-preset'],
    });
    expect(state.tasks.find(task => task.id === 'child-task')).toMatchObject({
      parentTaskId: 'parent-task', title: 'Delegated child', projectId: 'project-1',
    });
    expect(state.projects[0]).toMatchObject({
      name: 'Parent project', instructions: 'Parent project instructions', knowledge: ['vault-1'],
    });
    expect(state.memory).toMatchObject([{ id: 'memory-1', text: 'Parent decision' }]);
    expect(state.selectedTaskId).toBe('parent-task');
    expect(agentStore.useAgentStore.getState().threads['parent-task']).toMatchObject({
      draft: 'window draft', attachments: [{ id: 'attachment-1', name: 'notes.txt' }],
    });
    expect(agentStore.useAgentStore.getState().threads['child-task']?.entries).toContainEqual(
      expect.objectContaining({ id: 'child-user', text: 'Child task prompt' }),
    );
    expect(agentStore.useAgentStore.getState().threads['child-task']).toMatchObject({
      cwd: 'C:\\work\\parent', skills: 'project skill', accessMode: 'restricted',
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.after).toBe(40);
    expect(hostTasks.useHostTasks.getState().cursor).toBe(cursor);
  });

  it('rebases a renderer save when the host wins the same revision CAS', async () => {
    await start();
    const firstSave = deferred<void>();
    const saveCount = bridge.saveWorkspace.mock.calls.length;
    bridge.saveWorkspace.mockImplementationOnce(async (data: Record<string, unknown>, revision: number) => {
      await firstSave.promise;
      return compareAndSwap(data, revision);
    });

    workspace.editTask('parent-task', { title: 'Local edit during save' });
    const saving = workspace.flushWorkspace();
    await settle(() => bridge.saveWorkspace.mock.calls.length === saveCount + 1, 'renderer CAS attempt');

    const childRevision = hostAddsChild();
    emit(delegationEvents(cursor, childRevision));
    await settle(() => bridge.hostSnapshot.mock.calls.length >= 2, 'host snapshot request');
    firstSave.resolve();
    await saving;
    await settle(() => workspace.useWorkspaceStore.getState().tasks.some(task => task.id === 'child-task'), 'host snapshot merge');
    await workspace.flushWorkspace();

    expect(envelope.revision).toBeGreaterThan(childRevision);
    expect(envelope.data.tasks.find(task => task.id === 'parent-task')).toMatchObject({
      title: 'Local edit during save', instructions: 'Preserve parent task instructions',
      collaboratorPresetIds: ['reviewer-preset', 'child-preset'],
    });
    expect(envelope.data.tasks.find(task => task.id === 'child-task')).toMatchObject({
      parentTaskId: 'parent-task', title: 'Delegated child',
    });
    expect(workspace.useWorkspaceStore.getState().saveError).toBe('');
    expect(subscriptions).toHaveLength(1);
  });

  it('persists a local edit made while a successful save is in flight', async () => {
    await start();
    const firstSave = deferred<void>();
    const saveCount = bridge.saveWorkspace.mock.calls.length;
    bridge.saveWorkspace.mockImplementationOnce(async (data: Record<string, unknown>, revision: number) => {
      await firstSave.promise;
      return compareAndSwap(data, revision);
    });

    workspace.editTask('parent-task', { title: 'First local title' });
    const saving = workspace.flushWorkspace();
    await settle(() => bridge.saveWorkspace.mock.calls.length === saveCount + 1, 'first renderer save');
    workspace.editTask('parent-task', { title: 'Latest local title' });
    firstSave.resolve();
    await saving;
    await vi.advanceTimersByTimeAsync(500);
    await settle(() => bridge.saveWorkspace.mock.calls.length >= saveCount + 2, 'follow-up save for latest local edit');

    expect(bridge.saveWorkspace.mock.calls.length).toBeGreaterThanOrEqual(saveCount + 2);
    expect(bridge.saveWorkspace.mock.calls[saveCount]![0].tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'parent-task', title: 'First local title' })]),
    );
    expect(envelope.data.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'parent-task', title: 'Latest local title' })]),
    );
    expect(workspace.useWorkspaceStore.getState().saveError).toBe('');
  });

  it('does not let a delayed renderer save acknowledgement lower a newer host revision', async () => {
    await start();
    const acknowledgement = deferred<void>();
    const saveCount = bridge.saveWorkspace.mock.calls.length;
    let rendererRevision = 0;
    bridge.saveWorkspace.mockImplementationOnce(async (data: Record<string, unknown>, revision: number) => {
      rendererRevision = compareAndSwap(data, revision);
      await acknowledgement.promise;
      return rendererRevision;
    });

    workspace.editTask('parent-task', { title: 'Renderer committed title' });
    const saving = workspace.flushWorkspace();
    await settle(() => envelope.revision > 7 && bridge.saveWorkspace.mock.calls.length === saveCount + 1, 'renderer CAS commit');
    const childRevision = hostAddsChild();
    emit(delegationEvents(cursor, childRevision));
    await settle(() => bridge.hostSnapshot.mock.calls.length >= 2, 'newer host snapshot request');
    acknowledgement.resolve();
    await saving;
    await settle(() => workspace.useWorkspaceStore.getState().tasks.some(task => task.id === 'child-task'), 'newer host snapshot apply');

    workspace.editTask('parent-task', { instructions: 'A later local edit' });
    await workspace.flushWorkspace();
    expect(envelope.revision).toBeGreaterThanOrEqual(childRevision);
    expect(envelope.data.tasks.find(task => task.id === 'parent-task')).toMatchObject({
      title: 'Renderer committed title', instructions: 'A later local edit',
    });
    expect(envelope.data.tasks.find(task => task.id === 'child-task')).toMatchObject({
      id: 'child-task', parentTaskId: 'parent-task',
    });
    expect(agentStore.useAgentStore.getState().threads['child-task']).toMatchObject({
      cwd: 'C:\\work\\parent', skills: 'project skill', accessMode: 'restricted',
    });
    expect(workspace.useWorkspaceStore.getState().saveError).toBe('');
  });

  it('retains local project deletion intent across repeated reference conflicts', async () => {
    await start();
    hostAddsChild();

    await expect(workspace.removeProject('project-1')).rejects.toThrow('project-save-failed');
    expect(workspace.useWorkspaceStore.getState().projects).toEqual([]);
    expect(workspace.useWorkspaceStore.getState().tasks).toEqual([]);
    expect(workspace.useWorkspaceStore.getState().saveError).toBe('conflict');
    expect(workspace.getWorkspaceMergeConflicts().length).toBeGreaterThan(0);

    await hostTasks.refreshHostTasksSnapshot();
    await settle(() => bridge.hostSnapshot.mock.calls.length >= 2, 'repeated host snapshot');
    await settle(() => hostTasks.useHostTasks.getState().cursor === cursor, 'repeated conflict refresh');

    expect(workspace.useWorkspaceStore.getState().projects).toEqual([]);
    expect(workspace.useWorkspaceStore.getState().tasks).toEqual([]);
    expect(workspace.useWorkspaceStore.getState().saveError).toBe('conflict');
    expect(workspace.getWorkspaceMergeConflicts().length).toBeGreaterThan(0);
  });

  it('retries a rejected snapshot handler without dropping buffered host events', async () => {
    await start();
    const failedResponse = deferred<Snapshot>();
    const recoverySnapshot = clone(snapshot());
    const snapshotCalls = bridge.hostSnapshot.mock.calls.length;
    bridge.hostSnapshot.mockImplementationOnce(async () => failedResponse.promise);
    bridge.hostSnapshot.mockImplementationOnce(async () => recoverySnapshot);
    let handlerCalls = 0;
    hostTasks.setHostSnapshotHandler(async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) throw new Error('temporary workspace merge error');
    });

    emit({ type: 'resync' });
    await settle(() => bridge.hostSnapshot.mock.calls.length === snapshotCalls + 1, 'first resync snapshot');
    failedResponse.resolve(clone(snapshot()));
    await settle(() => handlerCalls === 1, 'rejected host snapshot handler');
    cursor += 1;
    emit(taskMessage(cursor, 'after-handler-failure'));

    await vi.advanceTimersByTimeAsync(500);
    await settle(() => handlerCalls === 2, 'host snapshot retry');
    await settle(() => hostTasks.useHostTasks.getState().cursor === cursor, 'buffered event after retry');
    expect(agentStore.useAgentStore.getState().threads['parent-task']?.entries).toContainEqual(
      expect.objectContaining({ id: 'after-handler-failure', text: 'arrived after snapshot' }),
    );
    expect(subscriptions).toHaveLength(1);
  });

  it('applies buffered events newer than a deferred snapshot and never rolls the cursor back', async () => {
    await start();
    const staleSnapshot = clone(snapshot());
    const staleResponse = deferred<Snapshot>();
    bridge.hostSnapshot.mockImplementationOnce(async () => staleResponse.promise);
    const childRevision = hostAddsChild();
    const snapshotAtTrigger = clone(snapshot());
    bridge.hostSnapshot.mockImplementationOnce(async () => snapshotAtTrigger);
    emit(delegationEvents(cursor, childRevision));
    await settle(() => bridge.hostSnapshot.mock.calls.length >= 2, 'deferred workspace refresh');
    cursor += 1;
    emit(taskMessage(cursor, 'live-after-snapshot'));

    staleResponse.resolve(staleSnapshot);
    await vi.advanceTimersByTimeAsync(500);
    await settle(() => bridge.hostSnapshot.mock.calls.length >= 3, 'retry after a stale snapshot');
    await settle(() => hostTasks.useHostTasks.getState().cursor === cursor, 'buffered event replay');
    await settle(() => workspace.useWorkspaceStore.getState().tasks.some(task => task.id === 'child-task'), 'child from synchronized workspace');
    expect(agentStore.useAgentStore.getState().threads['parent-task']?.entries).toContainEqual(
      expect.objectContaining({ id: 'live-after-snapshot', text: 'arrived after snapshot' }),
    );
    expect(hostTasks.useHostTasks.getState().cursor).toBe(cursor);
    expect(subscriptions).toHaveLength(1);
    expect(agentStore.useAgentStore.getState().threads['parent-task']?.draft).toBe('window draft');

    cursor += 1;
    emit(proposalEvent(cursor));
    expect(hostTasks.useHostTasks.getState().cursor).toBe(cursor);
    expect(agentStore.useAgentStore.getState().threads['parent-task']).toBeDefined();
  });
});
