import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../src/services/agentTasks', async importOriginal => ({ ...await importOriginal<typeof import('../src/services/agentTasks')>(), forkHostTask: vi.fn(async () => ({ status: 'accepted' })) }));
import { forkCodexTask } from '../src/features/agent/forkTask';
import { useWorkspaceStore } from '../src/features/agent/workspace';
import { EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';
import { forkHostTask } from '../src/services/agentTasks';

beforeEach(() => {
  vi.mocked(forkHostTask).mockReset().mockResolvedValue({ status: 'accepted' } as never);
  useWorkspaceStore.setState({ ready: true, saveError: '', projects: [{ id: 'project', name: 'Project', path: 'C:/project', skills: '', createdAt: 0 }], tasks: [{ id: 'source', projectId: 'project', title: 'Task', runtime: 'codex', connectionId: 'account', connectionProfileId: 'profile', cloudModel: 'model', accessMode: 'restricted', instructions: 'Keep context', archived: false, unread: false, createdAt: 0, updatedAt: 0 }], selectedTaskId: 'source', selectedProjectId: 'project' });
  useAgentStore.setState({ threads: { source: { ...EMPTY_AGENT, id: 'worker', nativeGeneration: 7, entries: [{ id: 'message', kind: 'assistant', text: 'Source result' }] } } });
});

it('forks into a distinct child without changing source history, identity or access', async () => {
  const source = structuredClone(useWorkspaceStore.getState().tasks[0]);
  const history = structuredClone(useAgentStore.getState().threads.source);
  await forkCodexTask('source');
  const workspace = useWorkspaceStore.getState(), child = workspace.tasks.find(task => task.id !== 'source')!;
  expect(child).toMatchObject({ parentTaskId: 'source', projectId: 'project', connectionId: 'account', cloudModel: 'model', accessMode: 'restricted', instructions: 'Keep context' });
  expect(workspace.tasks.find(task => task.id === 'source')).toEqual(source);
  expect(useAgentStore.getState().threads.source).toEqual(history);
  expect(forkHostTask).toHaveBeenCalledWith(expect.objectContaining({ sourceTaskId: 'source', taskId: child.id, expectedGeneration: 7 }));
});

it('refuses a running source and preserves an uncertain failed child for inspection', async () => {
  useAgentStore.setState(state => ({ threads: { ...state.threads, source: { ...state.threads.source, pending: true } } }));
  await expect(forkCodexTask('source')).rejects.toThrow('fork-unavailable');
  expect(forkHostTask).not.toHaveBeenCalled();
  useAgentStore.setState(state => ({ threads: { ...state.threads, source: { ...state.threads.source, pending: false } } }));
  vi.mocked(forkHostTask).mockRejectedValue(new Error('timeout'));
  await expect(forkCodexTask('source')).rejects.toThrow('timeout');
  expect(forkHostTask).toHaveBeenCalledTimes(1);
  expect(useAgentStore.getState().threads[useWorkspaceStore.getState().selectedTaskId]).toMatchObject({ error: 'fork-failed', ioError: 'Error: timeout' });
});
