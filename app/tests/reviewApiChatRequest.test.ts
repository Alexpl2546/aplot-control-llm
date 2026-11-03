import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class { onmessage: (event: unknown) => void = () => {}; } }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));

import { sendChat } from '../src/services/chat';
import type { ChatDelta } from '../src/features/chat/stream';

describe('OpenAI API chat IPC contract', () => {
  beforeEach(() => { mocks.invoke.mockReset(); });

  it('sends only the selected connection and supported chat data while preserving chat options', async () => {
    const request = {
      runId: '',
      generation: 0,
      cloud: { provider: 'chatgpt' as const, connectionId: 'api-key:profile-selected', model: 'gpt-4.1' },
      messages: [
        {
          id: 'user-message', role: 'user' as const, content: 'Question with quoted file text', displayContent: 'Question',
          attachmentText: 'private local attachment metadata', attachmentNames: ['notes.txt'],
          images: ['data:image/png;base64,AA=='], documents: [{ name: 'notes.pdf', data: 'data:application/pdf;base64,AA==' }],
          media: [{ name: 'clip.mp4', kind: 'video' as const, imageIndex: 0, path: 'C:/private/clip.mp4' }],
          blocks: [{ version: 1, id: 'local-block', type: 'unknown', sourceType: 'private', label: 'must stay local' }],
          usage: { inputTokens: 99 }, generationTps: 42,
        },
        { id: 'assistant-message', role: 'assistant' as const, content: 'Earlier answer', reasoning: 'internal reasoning', reasoningRu: 'translated reasoning' },
      ],
      maxTokens: 1200,
      temperature: 0.2,
      reasoning: 'high',
      instructions: 'Use the selected project context.',
      webSearch: true,
    };
    mocks.invoke.mockImplementation(async (name, args) => {
      expect(name).toBe('openai_chat_send');
      expect(args.request).toEqual({
        connectionId: 'api-key:profile-selected',
        model: 'gpt-4.1',
        messages: [
          { role: 'user', content: 'Question with quoted file text', images: ['data:image/png;base64,AA=='], documents: [{ name: 'notes.pdf', data: 'data:application/pdf;base64,AA==' }] },
          { role: 'assistant', content: 'Earlier answer' },
        ],
        maxTokens: 1200,
        effort: 'high',
        instructions: 'Use the selected project context.',
        webSearch: true,
      });
      expect(JSON.stringify(args.request)).not.toContain('other-profile');
      expect(JSON.stringify(args.request)).not.toContain('private local attachment metadata');
      expect(JSON.stringify(args.request)).not.toContain('private/clip.mp4');
      expect(JSON.stringify(args.request)).not.toContain('must stay local');
      args.onEvent.onmessage({ kind: 'ready', bytes: [] });
      args.onEvent.onmessage({ kind: 'chunk', bytes: [...new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n')] });
      args.onEvent.onmessage({ kind: 'finished', bytes: [] });
    });

    await sendChat(request, () => {}, new AbortController().signal);
  });

  it('marks an active response tool incomplete when the user cancels its stream', async () => {
    const abort = new AbortController(), deltas: ChatDelta[] = [];
    mocks.invoke.mockImplementation(async (name, args) => {
      if (name === 'openai_chat_send') {
        args.onEvent.onmessage({ kind: 'ready', bytes: [] });
        args.onEvent.onmessage({ kind: 'chunk', bytes: [...new TextEncoder().encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"search-live","type":"web_search_call","status":"in_progress"}}\n\n')] });
      }
    });
    const sending = sendChat({
      runId: '', generation: 0, messages: [{ role: 'user', content: 'Search this.' }], maxTokens: 256, temperature: 0,
      cloud: { provider: 'chatgpt', connectionId: 'api-key:profile-selected', model: 'gpt-4.1' },
    }, delta => deltas.push(delta), abort.signal);
    abort.abort();
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(deltas.flatMap(delta => delta.blocks ?? [])).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'incomplete' })]));
    expect(mocks.invoke.mock.calls.some(([name]) => name === 'openai_chat_cancel')).toBe(true);
  });
});
