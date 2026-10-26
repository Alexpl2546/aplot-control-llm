import { describe, expect, it } from 'vitest';
import { agentFrame, EMPTY_AGENT, useAgentStore } from '../src/features/agent/store';

describe('Hermes conversation events', () => {
  it('retains tool activity between commentary and the final answer without duplicating streamed text', () => {
    let thread = { ...EMPTY_AGENT, pending: true };
    thread = agentFrame(thread, { kind: 'event', type: 'message.delta', payload: { text: 'Checking.' } });
    thread = agentFrame(thread, { kind: 'event', type: 'tool.start', payload: { tool_id: 't1', name: 'read_file', args: { path: 'a.txt' } } });
    thread = agentFrame(thread, { kind: 'event', type: 'tool.complete', payload: { tool_id: 't1', name: 'read_file', result_text: 'hello' } });
    thread = agentFrame(thread, { kind: 'event', type: 'message.delta', payload: { text: 'Done' } });
    thread = agentFrame(thread, { kind: 'event', type: 'message.complete', payload: { text: 'Done', status: 'complete' } });
    expect(thread.entries.map(e => e.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(thread.entries[1]).toMatchObject({ status: 'unknown', details: '{\n  "path": "a.txt"\n}' });
    expect(thread.entries[2].text).toBe('Done'); expect(thread.pending).toBe(false);
  });
  it('withdraws only the matching question and clears permissions when a turn ends', () => {
    let thread = { ...EMPTY_AGENT, pending: true };
    for (const id of ['a', 'b']) thread = agentFrame(thread, { kind: 'request', id, method: 'approval', params: {} });
    thread = agentFrame(thread, { kind: 'event', type: 'request.cancel', payload: { id: 'a' } });
    expect(thread.requests.map(r => r.id)).toEqual(['b']);
    thread = agentFrame(thread, { kind: 'event', type: 'message.complete', payload: { status: 'interrupted' } });
    expect(thread.requests).toEqual([]); expect(thread.stopped).toBe(true);
  });
  it('keeps partial text after runtime loss and separates conversations across navigation', () => {
    useAgentStore.getState().update('one', () => agentFrame({ ...EMPTY_AGENT, id: 'owned', pending: true }, { kind: 'event', type: 'message.delta', payload: { text: 'partial' } }));
    useAgentStore.getState().setMode('chat'); useAgentStore.getState().setMode('agent');
    expect(useAgentStore.getState().threads.one.pending).toBe(true);
    const ended = agentFrame(useAgentStore.getState().threads.one, { kind: 'closed' });
    expect(ended.entries[0].text).toBe('partial'); expect(ended.id).toBeUndefined(); expect(ended.pending).toBe(false);
    expect(useAgentStore.getState().threads.two).toBeUndefined();
  });
  it('reports partial or failed turns as errors instead of success', () => {
    expect(agentFrame({ ...EMPTY_AGENT, pending: true }, { kind: 'event', type: 'message.complete', payload: { text: 'incomplete', partial: true } }).error).toBe('agent-error');
  });
});
