import { expect, it } from 'vitest';
import { savedConversation, parseChatHistory, type ChatConversation } from '../src/features/chat/historyModel';
import { EMPTY_THREAD } from '../src/features/chat/store';
import { serializeChatHistoryJson, parseChatHistoryImport } from '../src/features/chat/historyTransfer';

const conversation: ChatConversation = { id: 'conversation', title: 'Result', createdAt: 1, updatedAt: 2, target: { provider: 'chatgpt', connectionId: 'account', model: 'model', label: 'Model' } };

it('round-trips citations, tool state and usage without restoring an active tool', () => {
  const saved = savedConversation(conversation, { ...EMPTY_THREAD, pending: true, messages: [{ id: 'answer', role: 'assistant', content: 'Found a source', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, blocks: [
    { version: 1, id: 'search', type: 'tool', tool: 'web_search', status: 'in_progress', label: 'Search' },
    { version: 1, id: 'cite', type: 'citation', source: 'web', title: 'Source', url: 'https://example.org/source', startIndex: 0, endIndex: 5 },
  ] }] });
  const restored = parseChatHistoryImport(serializeChatHistoryJson({ version: 1, selectedId: conversation.id, conversations: [saved] })).conversations[0];
  expect(restored.thread).toMatchObject({ pending: false, stopped: true });
  expect(restored.thread.messages[0].blocks?.[0]).toMatchObject({ status: 'incomplete' });
  expect(restored.thread.messages[0].blocks?.[1]).toMatchObject({ url: 'https://example.org/source' });
  expect(restored.thread.messages[0].usage?.totalTokens).toBe(15);
});

it('keeps future blocks inert, removes unknown fields and rejects unsafe usage', () => {
  const saved = savedConversation(conversation, { ...EMPTY_THREAD, messages: [{ role: 'assistant', content: 'Result', blocks: [
    { version: 2, id: 'future', type: 'custom', apiKey: 'must-not-export', html: '<script>run()</script>' } as never,
    { version: 1, id: 'bad-link', type: 'citation', source: 'web', title: 'Untrusted', url: 'javascript:run()' },
  ] }] });
  const json = serializeChatHistoryJson({ version: 1, selectedId: conversation.id, conversations: [saved] });
  expect(json).not.toContain('must-not-export');
  expect(json).not.toContain('javascript:');
  expect(saved.thread.messages[0].blocks?.[0].type).toBe('unknown');
  const raw = JSON.parse(json);
  raw.conversations[0].thread.messages[0].usage = { totalTokens: -1 };
  expect(() => parseChatHistory(raw)).toThrow('chat-history-invalid');
});
