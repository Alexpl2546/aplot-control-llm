import { describe, expect, it } from 'vitest';
import { chatStream, type ChatDelta } from '../src/features/chat/stream';
import { useChatStore } from '../src/features/chat/store';

describe('chat stream', () => {
  it('decodes byte-split Unicode, reasoning and CRLF frames', () => {
    const deltas: ChatDelta[] = [], parser = chatStream(d => deltas.push(d));
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"план"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"Привет 🌍"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (const byte of bytes) parser.push(new Uint8Array([byte]));
    parser.finish();
    expect(deltas).toEqual([{ content: undefined, reasoning: 'план' }, { content: 'Привет 🌍', reasoning: undefined }]);
  });
  it('keeps partial text but reports early EOF and upstream errors', () => {
    let content = ''; const parser = chatStream(d => { content += d.content ?? ''; });
    parser.push(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    expect(() => parser.finish()).toThrow('incomplete'); expect(content).toBe('partial');
    const error = chatStream(() => {});
    expect(() => error.push(new TextEncoder().encode('event: error\ndata: {"error":{"message":"private detail"}}\n\n'))).toThrow('streamError');
  });
  it('accepts final unterminated DONE and never renders protocol metadata', () => {
    const deltas: ChatDelta[] = [], parser = chatStream(d => deltas.push(d));
    parser.push(new TextEncoder().encode(': ping\n\ndata: {"usage":{"total_tokens":12}}\n\ndata: [DONE]'));
    parser.finish(); expect(deltas).toEqual([]);
  });
  it('isolates conversations by server generation', () => {
    useChatStore.setState({ threads: {} });
    const { update } = useChatStore.getState();
    update('one:1', s => ({ ...s, draft: 'first', messages: [{ role: 'user', content: 'private to one' }] }));
    update('two:1', s => ({ ...s, draft: 'second' }));
    expect(useChatStore.getState().threads['two:1'].messages).toEqual([]);
    expect(useChatStore.getState().threads['one:2']).toBeUndefined();
    expect(useChatStore.getState().threads['one:1'].draft).toBe('first');
  });
  it('reports token-limit completion so a truncated translation is not presented as complete', () => {
    const deltas: ChatDelta[] = [], parser = chatStream(d => deltas.push(d));
    parser.push(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
    parser.finish();
    expect(deltas).toContainEqual({ finishReason: 'length' });
  });
});
