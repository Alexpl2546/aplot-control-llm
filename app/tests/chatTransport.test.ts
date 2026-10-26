import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class { onmessage: (event: unknown) => void = () => {}; } }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));
import { sendChat } from '../src/services/chat';

const request = { runId: 'profile:one', generation: 3, messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 200, temperature: .2 };
describe('native chat transport', () => {
  beforeEach(() => { mocks.invoke.mockReset(); });
  it('waits for ordered channel completion even when invoke resolves first', async () => {
    mocks.invoke.mockImplementation(async (name, args) => {
      expect(name).toBe('chat_send');
      expect(args.request).toEqual(request);
      args.onEvent.onmessage({ kind: 'ready', bytes: [] });
      setTimeout(() => {
        args.onEvent.onmessage({ kind: 'chunk', bytes: [...new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n')] });
        args.onEvent.onmessage({ kind: 'finished', bytes: [] });
      }, 0);
    });
    let text = '';
    await sendChat(request, d => { text += d.content ?? ''; }, new AbortController().signal);
    expect(text).toBe('hello');
  });
  it('cancels requests aborted before the native ready event', async () => {
    const abort = new AbortController();
    mocks.invoke.mockImplementation(async (name, args) => {
      if (name === 'chat_send') { abort.abort(); args.onEvent.onmessage({ kind: 'ready', bytes: [] }); }
    });
    await expect(sendChat(request, () => {}, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.invoke.mock.calls.some(([name]) => name === 'chat_cancel')).toBe(true);
  });
  it('stops malformed/error streams without exposing upstream details', async () => {
    mocks.invoke.mockImplementation(async (name, args) => {
      if (name === 'chat_send') args.onEvent.onmessage({ kind: 'chunk', bytes: [...new TextEncoder().encode('data: {"error":{"message":"secret backend detail"}}\n\n')] });
    });
    await expect(sendChat(request, () => {}, new AbortController().signal)).rejects.toThrow('streamError');
  });
});
