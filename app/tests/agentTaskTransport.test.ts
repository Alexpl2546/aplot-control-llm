import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: (message: unknown) => void }[] }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class MockChannel<T> {
    onmessage: (message: T) => void = () => undefined;
    constructor() { native.channels.push(this as { onmessage: (message: unknown) => void }); }
  },
}));

import {
  cancelHostTurn, enableHostRuntime, forkHostTask, hostSnapshot, interruptHostTask, prepareHostTask,
  resetHostTask, resolveHostApproval, resumeHostTask, rollbackHostRuntime, reviewHostTask, sendHostTask,
  setHostTaskAccess, steerHostTask, subscribeHost,
} from '../src/services/agentTasks';
import { followHostTasks } from '../src/features/agent/hostTasks';
import type { AplotClient, AgentTaskClient, HostStreamMessage } from '../src/services/client/agentTaskClient';
import { getAplotClient, getAplotClientSelection, resetAplotClient, selectAplotClient, withAplotClient } from '../src/services/client/selection';

function fakeClient() {
  const snapshot = { cursor: 7, hostRuntimes: ['codex'], tasks: [] };
  const sent = { commandId: 'send-1', taskId: 'task-1', turnId: 'turn-1', status: 'queued', aggregateRevision: 8 };
  const control = { commandId: 'control-1', taskId: 'task-1', status: 'accepted' };
  const approval = { status: 'resolved', alreadyResolved: false };
  const agentTasks: AgentTaskClient = {
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(async () => undefined),
    send: vi.fn(async () => sent),
    steer: vi.fn(async () => control),
    review: vi.fn(async () => control),
    fork: vi.fn(async () => control),
    prepare: vi.fn(async () => 'session-1'),
    resume: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
    setAccess: vi.fn(async () => undefined),
    resolveApproval: vi.fn(async () => approval),
    rollbackRuntime: vi.fn(async () => 2),
    enableRuntime: vi.fn(async () => 3),
  };
  return { client: { agentTasks } satisfies AplotClient, agentTasks, snapshot, sent, control, approval };
}

describe('agent task transport boundary', () => {
  beforeEach(() => { resetAplotClient(); native.invoke.mockReset(); native.channels.length = 0; });
  afterEach(() => resetAplotClient());

  it('routes every facade operation and its arguments through the selected typed client', async () => {
    const fake = fakeClient();
    const restore = selectAplotClient(fake.client);
    const config = { modelId: 'model-1', accessMode: 'restricted' as const };
    const attachment = { id: 'a', path: '/tmp/a.png', name: 'a.png', size: 1, kind: 'image' as const };
    const send = { commandId: 'send-1', taskId: 'task-1', runtime: 'codex', text: 'hello', attachments: [attachment], config };
    const steer = { commandId: 'steer-1', taskId: 'task-1', expectedTurnId: 'turn-1', expectedGeneration: 4, text: 'continue' };
    const review = { commandId: 'review-1', taskId: 'task-1', expectedGeneration: 4 };
    const fork = { commandId: 'fork-1', sourceTaskId: 'task-1', taskId: 'child-1', expectedGeneration: 4 };
    const onMessage = vi.fn();
    const streamMessage = { type: 'resync' as const };
    const approvalInput = { decision: 'once' };

    expect(await hostSnapshot()).toBe(fake.snapshot);
    await subscribeHost(6, onMessage);
    await sendHostTask(send);
    await steerHostTask(steer);
    await reviewHostTask(review);
    await forkHostTask(fork);
    await prepareHostTask('task-1', 'codex', config);
    await resumeHostTask('task-1');
    await interruptHostTask('task-1', true);
    await cancelHostTurn('task-1', 'turn-1');
    await resetHostTask('task-1');
    await setHostTaskAccess('task-1', 'restricted');
    await resolveHostApproval('approval-1', approvalInput);
    await rollbackHostRuntime('codex');
    await enableHostRuntime('claude');

    expect(fake.agentTasks.snapshot).toHaveBeenCalledOnce();
    expect(fake.agentTasks.subscribe).toHaveBeenCalledOnce();
    expect((fake.agentTasks.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(6);
    expect(fake.agentTasks.send).toHaveBeenCalledExactlyOnceWith(send);
    expect(fake.agentTasks.steer).toHaveBeenCalledExactlyOnceWith(steer);
    expect(fake.agentTasks.review).toHaveBeenCalledExactlyOnceWith(review);
    expect(fake.agentTasks.fork).toHaveBeenCalledExactlyOnceWith(fork);
    expect(fake.agentTasks.prepare).toHaveBeenCalledExactlyOnceWith('task-1', 'codex', config);
    expect(fake.agentTasks.resume).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(fake.agentTasks.interrupt).toHaveBeenCalledExactlyOnceWith('task-1', true);
    expect(fake.agentTasks.cancelTurn).toHaveBeenCalledExactlyOnceWith('task-1', 'turn-1');
    expect(fake.agentTasks.reset).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(fake.agentTasks.setAccess).toHaveBeenCalledExactlyOnceWith('task-1', 'restricted');
    expect(fake.agentTasks.resolveApproval).toHaveBeenCalledExactlyOnceWith('approval-1', approvalInput);
    expect(fake.agentTasks.rollbackRuntime).toHaveBeenCalledExactlyOnceWith('codex');
    expect(fake.agentTasks.enableRuntime).toHaveBeenCalledExactlyOnceWith('claude');

    // A selected client receives stream messages through the callback supplied by the facade.
    const delivered = (fake.agentTasks.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (message: typeof streamMessage) => void;
    delivered(streamMessage);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(streamMessage);
    restore();
  });

  it('retries an ambiguous steer reply with the exact same request and command ID', async () => {
    const fake = fakeClient();
    fake.agentTasks.steer = vi.fn().mockRejectedValueOnce(new Error('socket closed unexpectedly')).mockResolvedValue(fake.control);
    const restore = selectAplotClient(fake.client);
    const request = { commandId: 'same-id', taskId: 'task-1', expectedTurnId: 'turn-1', expectedGeneration: 2, text: 'more' };

    await expect(steerHostTask(request)).resolves.toBe(fake.control);
    expect(fake.agentTasks.steer).toHaveBeenCalledTimes(2);
    expect(fake.agentTasks.steer).toHaveBeenNthCalledWith(1, request);
    expect(fake.agentTasks.steer).toHaveBeenNthCalledWith(2, request);
    restore();
  });

  it('does not retry a domain rejection or an ambiguous review reply', async () => {
    const fake = fakeClient();
    const restore = selectAplotClient(fake.client);
    const request = { commandId: 'review-1', taskId: 'task-1', expectedGeneration: 4 };
    fake.agentTasks.steer = vi.fn().mockRejectedValue(new Error('stale'));
    await expect(steerHostTask({ commandId: 'steer-1', taskId: 'task-1', expectedTurnId: 'turn-1', expectedGeneration: 4, text: 'x' })).rejects.toThrow('stale');
    expect(fake.agentTasks.steer).toHaveBeenCalledOnce();

    fake.agentTasks.review = vi.fn().mockRejectedValue(new Error('socket closed unexpectedly'));
    await expect(reviewHostTask(request)).rejects.toThrow('socket closed unexpectedly');
    expect(fake.agentTasks.review).toHaveBeenCalledOnce();
    restore();
  });

  it('restores scoped selections after nested, out-of-order, and rejected scopes', async () => {
    const outer = fakeClient(), inner = fakeClient();
    const restoreOuter = selectAplotClient(outer.client);
    const restoreInner = selectAplotClient(inner.client);
    expect(getAplotClient()).toBe(inner.client);
    restoreOuter();
    expect(getAplotClient()).toBe(inner.client);
    restoreInner();
    expect(getAplotClient()).not.toBe(inner.client);

    await expect(withAplotClient(outer.client, async () => {
      expect(getAplotClient()).toBe(outer.client);
      throw new Error('scope-ended');
    })).rejects.toThrow('scope-ended');
    expect(getAplotClient()).not.toBe(outer.client);
    const cleanup = selectAplotClient(inner.client);
    resetAplotClient();
    cleanup();
    expect(getAplotClient()).not.toBe(inner.client);
  });

  it('fences callbacks from a previous selected client after switching and subscribing again', async () => {
    const first = fakeClient(), second = fakeClient();
    const firstCallbacks: ((message: HostStreamMessage) => void)[] = [];
    const secondCallbacks: ((message: HostStreamMessage) => void)[] = [];
    first.agentTasks.subscribe = vi.fn(async (_after, onMessage) => { firstCallbacks.push(onMessage); });
    second.agentTasks.subscribe = vi.fn(async (_after, onMessage) => { secondCallbacks.push(onMessage); });
    const oldReceiver = vi.fn(), newReceiver = vi.fn();

    const restoreFirst = selectAplotClient(first.client);
    await subscribeHost(0, oldReceiver);
    const firstSelection = getAplotClientSelection();
    restoreFirst();
    const restoreSecond = selectAplotClient(second.client);
    expect(getAplotClientSelection().generation).toBeGreaterThan(firstSelection.generation);
    await subscribeHost(5, newReceiver);

    const message: HostStreamMessage = { type: 'resync' };
    firstCallbacks[0]!(message);
    secondCallbacks[0]!(message);
    expect(oldReceiver).not.toHaveBeenCalled();
    expect(newReceiver).toHaveBeenCalledExactlyOnceWith(message);
    restoreSecond();
  });

  it('preserves callback order for repeated subscriptions on the same client', async () => {
    const fake = fakeClient();
    const callbacks: ((message: HostStreamMessage) => void)[] = [];
    fake.agentTasks.subscribe = vi.fn(async (_after, onMessage) => { callbacks.push(onMessage); });
    const firstReceiver = vi.fn(), secondReceiver = vi.fn();
    const restore = selectAplotClient(fake.client);
    const generation = getAplotClientSelection().generation;

    await subscribeHost(3, firstReceiver);
    await subscribeHost(4, secondReceiver);
    expect(getAplotClientSelection().generation).toBe(generation);
    const firstMessage: HostStreamMessage = { type: 'resync' };
    const secondMessage: HostStreamMessage = { type: 'events', events: [] };
    callbacks[0]!(firstMessage);
    callbacks[1]!(secondMessage);
    expect(firstReceiver.mock.calls).toEqual([[firstMessage]]);
    expect(secondReceiver.mock.calls).toEqual([[secondMessage]]);
    restore();
  });

  it('deactivates a failed stream attempt without blocking a retry', async () => {
    const fake = fakeClient();
    let failedCallback: ((message: HostStreamMessage) => void) | undefined;
    let retryCallback: ((message: HostStreamMessage) => void) | undefined;
    fake.agentTasks.subscribe = vi.fn()
      .mockImplementationOnce(async (_after, onMessage) => { failedCallback = onMessage; throw new Error('stream-failed'); })
      .mockImplementationOnce(async (_after, onMessage) => { retryCallback = onMessage; });
    const receiver = vi.fn();
    const restore = selectAplotClient(fake.client);

    await expect(subscribeHost(0, receiver)).rejects.toThrow('stream-failed');
    await subscribeHost(0, receiver);
    const message: HostStreamMessage = { type: 'resync' };
    failedCallback!(message);
    retryCallback!(message);
    expect(fake.agentTasks.subscribe).toHaveBeenCalledTimes(2);
    expect(receiver).toHaveBeenCalledExactlyOnceWith(message);
    restore();
  });

  it('lets followHostTasks retry after a rejected subscription', async () => {
    const fake = fakeClient();
    fake.agentTasks.subscribe = vi.fn().mockRejectedValueOnce(new Error('stream-failed')).mockResolvedValue(undefined);
    const restore = selectAplotClient(fake.client);

    await followHostTasks();
    expect(fake.agentTasks.subscribe).toHaveBeenCalledTimes(1);
    await followHostTasks();
    expect(fake.agentTasks.subscribe).toHaveBeenCalledTimes(2);
    restore();
  });

  it('maps the Tauri adapter to the existing commands and replaces its stream on repeat subscribe', async () => {
    const config = { language: 'en' };
    const send = { commandId: 'send', taskId: 'task', runtime: 'codex', text: 'hello', attachments: [] };
    const steer = { commandId: 'steer', taskId: 'task', expectedTurnId: 'turn', expectedGeneration: 1, text: 'next' };
    const review = { commandId: 'review', taskId: 'task', expectedGeneration: 1 };
    const fork = { commandId: 'fork', sourceTaskId: 'task', taskId: 'child', expectedGeneration: 1 };
    const onMessage = vi.fn();
    native.invoke.mockResolvedValue(undefined);

    await hostSnapshot();
    await subscribeHost(10, onMessage);
    await subscribeHost(11, onMessage);
    await sendHostTask(send);
    await steerHostTask(steer);
    await reviewHostTask(review);
    await forkHostTask(fork);
    await prepareHostTask('task', 'codex', config);
    await resumeHostTask('task');
    await interruptHostTask('task', false);
    await cancelHostTurn('task', 'turn');
    await resetHostTask('task');
    await setHostTaskAccess('task', 'full');
    await resolveHostApproval('approval', { decision: 'deny' });
    await rollbackHostRuntime('claude');
    await enableHostRuntime('codex');

    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      'agent_tasks_snapshot', 'agent_tasks_subscribe', 'agent_tasks_subscribe', 'agent_task_send',
      'agent_task_steer', 'agent_task_review', 'agent_task_fork', 'agent_task_prepare', 'agent_task_resume',
      'agent_task_interrupt', 'agent_task_cancel_queued', 'agent_task_reset_session', 'agent_task_access',
      'agent_approval_resolve', 'agent_tasks_rollback', 'agent_tasks_enable',
    ]);
    expect(native.invoke.mock.calls[1]?.[1]).toEqual({ after: 10, onEvent: native.channels[0] });
    expect(native.invoke.mock.calls[2]?.[1]).toEqual({ after: 11, onEvent: native.channels[1] });
    expect(native.invoke.mock.calls.slice(3).map(([, args]) => args)).toEqual([
      { request: send }, { request: steer }, { request: review }, { request: fork },
      { taskId: 'task', runtime: 'codex', config }, { taskId: 'task' }, { taskId: 'task', close: false },
      { taskId: 'task', turnId: 'turn' }, { taskId: 'task' }, { taskId: 'task', mode: 'full' },
      { approvalId: 'approval', result: { decision: 'deny' } }, { runtime: 'claude' }, { runtime: 'codex' },
    ]);
  });
});
