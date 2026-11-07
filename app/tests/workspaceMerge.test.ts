import { describe, expect, it } from 'vitest';
import { mergeWorkspace } from '../src/features/agent/workspaceMerge';

const task = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: id, projectId: 'p1', updatedAt: 1, unread: false, ...fields });
const preset = (id: string, fields: Record<string, unknown> = {}) => ({ id, name: id, instructions: 'base', ...fields });

describe('mergeWorkspace', () => {
  it('merges disjoint entity fields and preserves local selection and drafts', () => {
    const base = {
      projects: [{ id: 'p1', name: 'Project', path: '/p1' }],
      tasks: [task('t1', { title: 'Base' })],
      presets: [preset('a1')],
      memory: [{ id: 'm1', text: 'base', category: 'fact' }],
      threads: { t1: { draft: 'old' } }, selectedTaskId: 't1', mode: 'chat',
    };
    const local = {
      ...base,
      projects: [{ id: 'p1', name: 'Local name', path: '/p1' }],
      tasks: [task('t1', { title: 'Local title' })],
      threads: { t1: { draft: 'typed locally' } }, selectedTaskId: 't1',
    };
    const remote = {
      ...base,
      projects: [{ id: 'p1', name: 'Project', path: '/remote-path' }],
      tasks: [task('t1', { title: 'Base', collaboratorPresetIds: ['a1'] })],
      presets: [preset('a1', { instructions: 'remote instructions' })],
      memory: [{ id: 'm1', text: 'base', category: 'decision' }],
      threads: { t1: { draft: 'stale remote draft' } }, selectedTaskId: 'remote-selection', mode: 'agent',
    };

    const result = mergeWorkspace(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.data.projects).toEqual([{ id: 'p1', name: 'Local name', path: '/remote-path' }]);
    expect(result.data.tasks).toEqual([task('t1', { title: 'Local title', collaboratorPresetIds: ['a1'] })]);
    expect(result.data.presets).toEqual([preset('a1', { instructions: 'remote instructions' })]);
    expect(result.data.memory).toEqual([{ id: 'm1', text: 'base', category: 'decision' }]);
    expect(result.data.threads).toEqual({ t1: { draft: 'typed locally' } });
    expect(result.data.selectedTaskId).toBe('t1');
    expect(result.data.mode).toBe('chat');
  });

  it('keeps remote server-created children and presets while retaining local additions', () => {
    const base = { projects: [{ id: 'p1' }], tasks: [task('parent')], presets: [preset('base')], memory: [] };
    const local = {
      ...base,
      tasks: [task('parent'), task('local-task', { parentTaskId: 'parent' })],
      presets: [preset('base'), preset('local-preset')],
    };
    const remote = {
      ...base,
      tasks: [task('parent'), task('server-child', { parentTaskId: 'parent', presetId: 'server-preset' })],
      presets: [preset('base'), preset('server-preset', { name: 'Server specialist' })],
    };

    const result = mergeWorkspace(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect((result.data.tasks as Array<{ id: string }>).map(item => item.id)).toEqual(['parent', 'server-child', 'local-task']);
    expect((result.data.presets as Array<{ id: string }>).map(item => item.id)).toEqual(['base', 'server-preset', 'local-preset']);
  });

  it('reports same-field and edit-versus-delete conflicts without discarding local values', () => {
    const base = { projects: [{ id: 'p1', name: 'Base' }], tasks: [task('t1', { title: 'Base' })], presets: [], memory: [] };
    const local = { ...base, projects: [{ id: 'p1', name: 'Local' }], tasks: [] };
    const remote = { ...base, projects: [{ id: 'p1', name: 'Remote' }], tasks: [task('t1', { title: 'Remote' })] };

    const result = mergeWorkspace(base, local, remote);
    expect(result.data.projects).toEqual([{ id: 'p1', name: 'Local' }]);
    expect(result.data.tasks).toEqual([]);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'projects[id="p1"].name', reason: 'field', base: 'Base', local: 'Local', remote: 'Remote' }),
      expect.objectContaining({ path: 'tasks[id="t1"]', reason: 'edit-delete', local: undefined, remote: task('t1', { title: 'Remote' }) }),
    ]));
  });

  it('merges disjoint fields on an entity added concurrently by both sides and reports same-field conflicts', () => {
    const base = { projects: [], tasks: [], presets: [], memory: [] };
    const local = { ...base, presets: [{ id: 'new', name: 'Local name' }] };
    const remote = { ...base, presets: [{ id: 'new', instructions: 'Remote instructions' }] };
    const result = mergeWorkspace(base, local, remote);

    expect(result.data.presets).toEqual([{ id: 'new', name: 'Local name', instructions: 'Remote instructions' }]);
    expect(result.conflicts).toEqual([]);
  });

  it('uses max updatedAt and local unread intent without treating streaming bookkeeping as conflict', () => {
    const base = { projects: [{ id: 'p1' }], tasks: [task('t1', { updatedAt: 2, unread: true, title: 'Base' })], presets: [], memory: [] };
    const local = { ...base, tasks: [task('t1', { updatedAt: 9, unread: false, title: 'Base' })] };
    const remote = { ...base, tasks: [task('t1', { updatedAt: 4, unread: true, title: 'Remote' })] };
    const result = mergeWorkspace(base, local, remote);

    expect(result.data.tasks).toEqual([task('t1', { updatedAt: 9, unread: false, title: 'Remote' })]);
    expect(result.conflicts).toEqual([]);
  });

  it('retains references when a local deletion races a server-created child', () => {
    const base = {
      projects: [{ id: 'p1', name: 'Project' }],
      tasks: [task('parent', { projectId: 'p1' })],
      presets: [preset('agent')], memory: [],
    };
    const local = { projects: [], tasks: [], presets: [], memory: [] };
    const remote = {
      projects: [{ id: 'p1', name: 'Project' }],
      tasks: [task('parent', { projectId: 'p1', presetId: 'agent' }), task('child', { projectId: 'p1', parentTaskId: 'parent', presetId: 'agent' })],
      presets: [preset('agent')], memory: [],
    };

    const result = mergeWorkspace(base, local, remote);
    expect((result.data.projects as Array<{ id: string }>).map(item => item.id)).toEqual(['p1']);
    expect((result.data.tasks as Array<{ id: string }>).map(item => item.id)).toEqual(['parent', 'child']);
    expect((result.data.presets as Array<{ id: string }>).map(item => item.id)).toEqual(['agent']);
    expect(result.conflicts.map(item => item.reason)).toEqual(['edit-delete', 'reference-delete', 'reference-delete', 'reference-delete']);
  });

  it('reports concurrent reorder conflicts and retains both sides additions', () => {
    const base = { projects: [], tasks: [task('a'), task('b'), task('c')], presets: [], memory: [] };
    const local = { ...base, tasks: [task('b'), task('a'), task('c'), task('local')] };
    const remote = { ...base, tasks: [task('a'), task('c'), task('b'), task('remote')] };
    const result = mergeWorkspace(base, local, remote);

    expect((result.data.tasks as Array<{ id: string }>).map(item => item.id)).toEqual(['b', 'a', 'c', 'local', 'remote']);
    expect(result.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tasks.$order', reason: 'order' })]));
  });
});
