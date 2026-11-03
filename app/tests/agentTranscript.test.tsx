// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../src/lib/i18n';
import { WorkspaceTranscript } from '../src/features/agent/WorkspaceMessages';
import { EMPTY_AGENT, agentFrame, type AgentEntry } from '../src/features/agent/store';
import { applyHostEvent, projectTask, type HostTaskView } from '../src/features/agent/taskProjection';

vi.mock('../src/features/agent/AgentTurnResults', () => ({
  AgentTurnResults: ({ entries }: { entries: AgentEntry[] }) => <output>{entries.map(entry => entry.id).join(',')}</output>,
}));

beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

it('keeps grouped actions and a steering message in order within the original turn', () => {
  const entries: AgentEntry[] = [
    { id: 'u1', kind: 'user', text: 'Find the issue' },
    { id: 't1', kind: 'tool', name: 'read_file', args: { path: 'first.ts' }, status: 'error', text: 'File not found' },
    { id: 't2', kind: 'tool', name: 'read_file', args: { path: 'second.ts' }, status: 'success', text: 'Read output' },
    { id: 'steer:c1', kind: 'user', text: 'Also check the tests' },
    { id: 't3', kind: 'tool', name: 'apply_patch', status: 'success', text: 'Patched', diff: '+ change' },
    { id: 'a1', kind: 'assistant', text: 'The issue is fixed.' },
    { id: 'u2', kind: 'user', text: 'Keep going' },
    { id: 't4', kind: 'tool', name: 'read_file', args: { path: 'third.ts' }, status: 'error', text: 'Another failure' },
    { id: 't5', kind: 'tool', name: 'read_file', args: { path: 'fourth.ts' }, status: 'running', text: '' },
  ];
  const { container } = render(<WorkspaceTranscript entries={entries} taskId="task" turnOutcomes={{ u1: 'completed' }}
    onMemory={vi.fn()} onCopied={vi.fn()}/>);
  const groups = container.querySelectorAll('.awToolGroup');
  expect(groups).toHaveLength(2);
  expect([...groups[0]!.querySelectorAll('.awToolTitle code')].map(node => node.textContent)).toEqual(['first.ts', 'second.ts']);
  expect(groups[1]!.querySelector('summary')?.textContent).toMatch(/fourth\.ts.*Running.*Failed/);
  expect(screen.getByText('File not found').closest('details')).toBeTruthy();
  expect(screen.getByText('+ change').closest('details')).toBeTruthy();
  expect(screen.getByText('Direction for the current turn')).toBeTruthy();
  expect(screen.getAllByText('Turn completed')).toHaveLength(1);
  expect(screen.getByText('u1,t1,t2,steer:c1,t3,a1')).toBeTruthy();
});

it('retains host turn outcomes from a snapshot and projects only matching terminal events', () => {
  const view: HostTaskView = {
    id: 'task', runtime: 'codex', revision: 10,
    state: { pending: true, starting: false, ended: false, stopped: false, error: '', live: true, children: [] },
    messages: [{ id: 'old', kind: 'user', text: 'Previous turn' }, { id: 'new', kind: 'user', text: 'This turn' }],
    turns: [], approvals: [], turnOutcomes: { old: 'completed' },
  };
  const thread = projectTask(view, EMPTY_AGENT);
  const event = { seq: 11, taskId: 'task', revision: 11, at: '', kind: 'turn.upsert' as const,
    payload: { turn: { id: 'turn', taskId: 'task', status: 'interrupted' as const, messageId: 'new', text: 'This turn' } } };
  expect(thread.turnOutcomes).toEqual({ old: 'completed' });
  expect(applyHostEvent(thread, event).turnOutcomes).toEqual({ old: 'completed', new: 'interrupted' });
  const partial = { ...event, payload: { turn: { ...event.payload.turn, status: 'completed' as const, error: 'Partial answer' } } };
  expect(applyHostEvent(thread, partial).turnOutcomes).toEqual({ old: 'completed', new: 'failed' });
  const neverStarted = { ...event, payload: { turn: { ...event.payload.turn, status: 'failed' as const, messageId: 'absent' } } };
  expect(applyHostEvent(thread, neverStarted).turnOutcomes).toBe(thread.turnOutcomes);
});

it('records an explicit local completion only for the active turn and keeps partial results failed', () => {
  const active = { ...EMPTY_AGENT, pending: true, entries: [{ id: 'u1', kind: 'user' as const, text: 'Continue' }] };
  const final = agentFrame(active, { kind: 'event', type: 'message.complete', payload: { status: 'complete', partial: true, text: 'Partial answer' } });
  expect(final.turnOutcomes).toEqual({ u1: 'failed' });
  const replay = agentFrame(final, { kind: 'event', type: 'message.complete', payload: { status: 'complete' } });
  expect(replay.turnOutcomes).toBe(final.turnOutcomes);
});
