// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
const controls = vi.hoisted(() => ({ steerHostTask: vi.fn(), reviewHostTask: vi.fn() }));
const enqueueAgent = vi.hoisted(() => vi.fn());
vi.mock('../src/services/agentTasks', () => controls);
vi.mock('../src/features/agent/AgentInputTools', () => ({
  AgentInputTools: ({ action, children }: { action?: ReactNode; children?: ReactNode }) => <>{children}{action}</>,
  AttachmentChips: () => null,
  addAgentFiles: vi.fn(),
}));
vi.mock('../src/features/agent/AgentContextMeter', () => ({ AgentContextMeter: () => null }));
vi.mock('../src/features/agent/generation', () => ({
  enqueueAgent,
  sendQueuedAgent: vi.fn(),
  removeQueuedAgent: vi.fn(),
  finishAgentDictation: vi.fn(),
}));
vi.mock('../src/features/reasoning/reasoning', () => ({ ReasoningSelect: () => null }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
import { CodexTaskControls } from '../src/features/agent/CodexTaskControls';
import { AgentComposer } from '../src/features/agent/AgentComposer';
import { EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';
import type { AgentTask } from '../src/features/agent/workspaceModel';

const task: AgentTask = {
  id: 'task-1', projectId: 'project-1', title: 'Task', runtime: 'codex',
  createdAt: 0, updatedAt: 0, archived: false, unread: false,
};
const active = {
  ...EMPTY_AGENT, id: 'host:task-1', pending: true, activeNativeTurnId: 'native-turn-9', nativeGeneration: 3,
};

function Composer({ runtime = task.runtime, onStop = () => {} }: { runtime?: AgentTask['runtime']; onStop?: () => void }) {
  const thread = useAgentStore(state => state.threads[task.id]!);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return <AgentComposer
    task={{ ...task, runtime }}
    thread={thread}
    ready
    saveError={false}
    inputRef={inputRef}
    modelLabel="Codex"
    onSend={() => {}}
    onStop={onStop}
    onPrepare={() => {}}
    onNewSession={() => {}}
    onConnection={() => {}}
  />;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'command-id') });
  controls.steerHostTask.mockResolvedValue({ status: 'accepted' });
  controls.reviewHostTask.mockResolvedValue({ status: 'accepted' });
  useAgentStore.setState({ threads: { [task.id]: active } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('queues by default and sends a direction to the projected native turn only on explicit action', async () => {
  const onStop = vi.fn();
  render(<Composer onStop={onStop}/>);
  const field = screen.getByRole('textbox', { name: 'chat.input' });
  fireEvent.change(field, { target: { value: 'Focus on the failing test' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(enqueueAgent).toHaveBeenCalledWith('task-1', 'en');
  expect(controls.steerHostTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'codex.controls.steerLabel' }));
  await waitFor(() => expect(controls.steerHostTask).toHaveBeenCalledWith({
    commandId: 'command-id', taskId: 'task-1', expectedTurnId: 'native-turn-9', expectedGeneration: 3, text: 'Focus on the failing test',
  }));
  await screen.findByText('codex.controls.steerAccepted');
  expect((field as HTMLTextAreaElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'aw.stopTask' }));
  expect(onStop).toHaveBeenCalledTimes(1);
});

it('preserves the original direction and new draft when the active turn changes in flight', async () => {
  let reject!: (reason: unknown) => void;
  controls.steerHostTask.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  render(<Composer/>);
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'First direction' } });
  fireEvent.click(screen.getByRole('button', { name: 'codex.controls.steerLabel' }));
  expect(screen.getByRole('status').textContent).toBe('codex.controls.steerSending');
  fireEvent.change(field, { target: { value: 'New draft' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(enqueueAgent).not.toHaveBeenCalled();
  reject(new Error('stale'));
  await screen.findByRole('alert');
  expect(field.value).toBe('First direction\n\nNew draft');
});

it('reuses the command ID for an exact retry after switching away from the composer', async () => {
  controls.steerHostTask.mockRejectedValueOnce(new Error('timeout'));
  const { unmount } = render(<Composer/>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Investigate the failing check' } });
  fireEvent.click(screen.getByRole('button', { name: 'codex.controls.steerLabel' }));
  await screen.findByRole('alert');
  const firstRequest = controls.steerHostTask.mock.calls[0]?.[0];
  unmount();

  render(<Composer/>);
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(field.value).toBe('Investigate the failing check');
  const steer = screen.getByRole('button', { name: 'codex.controls.steerLabel' });
  fireEvent.click(steer);
  await screen.findByText('codex.controls.steerAccepted');
  expect(controls.steerHostTask).toHaveBeenNthCalledWith(2, firstRequest);
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);

  fireEvent.change(field, { target: { value: 'Investigate the failing check' } });
  fireEvent.click(steer);
  await screen.findByText('codex.controls.steerAccepted');
  expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
});

it('keeps attached files in the queue path and omits steering outside Codex', () => {
  const attachment = { id: 'file-1', path: '/report.txt', name: 'report.txt', kind: 'file' as const, size: 5 };
  useAgentStore.setState({ threads: { [task.id]: { ...active, draft: 'Read this', attachments: [attachment] } } });
  const { rerender } = render(<Composer/>);
  expect((screen.getByRole('button', { name: 'codex.controls.steerLabel' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'aw.composer.enqueue' }));
  expect(enqueueAgent).toHaveBeenCalledWith('task-1', 'en');
  expect(controls.steerHostTask).not.toHaveBeenCalled();
  rerender(<Composer runtime="hermes"/>);
  expect(screen.queryByRole('button', { name: 'codex.controls.steerLabel' })).toBeNull();
});

it('offers review only while idle and leaves a single composer in the task', async () => {
  const { rerender } = render(<CodexTaskControls taskId="task-1" workerGeneration={3} pending />);
  expect((screen.getByRole('button', { name: 'codex.controls.review' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();

  rerender(<CodexTaskControls taskId="task-1" workerGeneration={3} pending={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'codex.controls.review' }));
  await waitFor(() => expect(controls.reviewHostTask).toHaveBeenCalledWith({ commandId: 'command-id', taskId: 'task-1', expectedGeneration: 3 }));
});

it('disables Codex controls when the worker generation is missing', () => {
  useAgentStore.setState({ threads: { [task.id]: { ...active, draft: 'Follow up', nativeGeneration: undefined } } });
  render(<><CodexTaskControls taskId="task-1" pending={false}/><Composer/></>);
  expect((screen.getByRole('button', { name: 'codex.controls.review' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'codex.controls.steerLabel' })).toBeNull();
  expect((screen.getByRole('button', { name: 'aw.composer.enqueue' }) as HTMLButtonElement).disabled).toBe(false);
});

it('offers parent-owned native fork only for an idle, current Codex session', async () => {
  const onFork = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<CodexTaskControls taskId="source" workerGeneration={4} pending={false} onFork={onFork} />);
  const forkButton = screen.getByRole('button', { name: 'codex.controls.fork' });
  expect((forkButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(forkButton);
  await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));

  rerender(<CodexTaskControls taskId="source" workerGeneration={4} pending onFork={onFork} />);
  expect((screen.getByRole('button', { name: 'codex.controls.fork' }) as HTMLButtonElement).disabled).toBe(true);
});
