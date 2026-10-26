import { beforeEach, expect, it } from 'vitest';
import { EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';
import { assignAgentPreset, saveAgentPreset, useWorkspaceStore } from '../src/features/agent/workspace';

beforeEach(() => {
  useAgentStore.setState({ threads: { task: { ...EMPTY_AGENT, draft: 'Keep the draft' } } });
  useWorkspaceStore.setState({
    ready: false,
    tasks: [{ id: 'task', projectId: 'project', title: 'Task', archived: false, unread: false, createdAt: 1, updatedAt: 1 }],
    presets: [{ id: 'reviewer', name: 'Reviewer', runtime: 'hermes', instructions: 'Review code', accessMode: 'restricted' }],
  });
});

it('switches a preset task to Custom while preserving editable settings and its draft', () => {
  assignAgentPreset('task', 'reviewer');
  expect(useWorkspaceStore.getState().tasks[0]).toMatchObject({ presetId: 'reviewer', agentName: 'Reviewer' });
  assignAgentPreset('task', '');
  expect(useWorkspaceStore.getState().tasks[0]).toMatchObject({ presetId: undefined, agentName: undefined, runtime: 'hermes', accessMode: 'restricted', instructions: 'Review code' });
  expect(useAgentStore.getState().threads.task.draft).toBe('Keep the draft');
});

it('keeps the agent identity pinned after a session has started', () => {
  assignAgentPreset('task', 'reviewer');
  useAgentStore.getState().update('task', thread => ({ ...thread, id: 'live-session' }));
  expect(() => assignAgentPreset('task', '')).toThrow('session-pinned');
  expect(useWorkspaceStore.getState().tasks[0].presetId).toBe('reviewer');
});

it('renames a linked agent in live tasks without changing session settings', () => {
  assignAgentPreset('task', 'reviewer');
  useAgentStore.getState().update('task', thread => ({ ...thread, id: 'live-session' }));
  const original = useWorkspaceStore.getState().tasks[0];
  saveAgentPreset({ ...useWorkspaceStore.getState().presets[0], name: '  Senior reviewer  ', instructions: 'New instructions', accessMode: 'full' });
  expect(useWorkspaceStore.getState().presets[0].name).toBe('Senior reviewer');
  expect(useWorkspaceStore.getState().tasks[0]).toEqual({ ...original, agentName: 'Senior reviewer' });
  expect(useAgentStore.getState().threads.task.id).toBe('live-session');
});

it('limits new and renamed agent names to 20 characters without discarding existing legacy names',()=>{
 const preset=useWorkspaceStore.getState().presets[0];
 expect(()=>saveAgentPreset({...preset,name:'W'.repeat(21)})).toThrow('preset-limit');
 useWorkspaceStore.setState({presets:[{...preset,name:'Legacy name longer than 20 characters'}]});
 expect(()=>saveAgentPreset({...preset,name:'Legacy name longer than 20 characters',instructions:'Updated'})).not.toThrow();
});
