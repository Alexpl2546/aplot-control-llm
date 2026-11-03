import { expect, it } from 'vitest';
import { EMPTY_THREAD } from '../src/features/chat/store';
import { parseChatHistory, savedConversation, type ChatTarget } from '../src/features/chat/historyModel';
import { parseChatHistoryImport, serializeChatHistoryJson, serializeChatHistoryMarkdown } from '../src/features/chat/historyTransfer';

const target: ChatTarget = { provider: 'chatgpt', connectionId: 'connection-1', profileId: 'profile-1', model: 'gpt-test', label: 'ChatGPT' };

function sample() {
  const conversation = savedConversation({ id: 'conversation-1', title: 'A Markdown test', createdAt: 1, updatedAt: 2, target, pinnedAt: 3, webSearch: true }, {
    ...EMPTY_THREAD,
    messages: [
      { id: 'user-1', role: 'user', content: 'Hello\n<!-- aplot-message:AAAA -->\n> quoted', displayContent: 'Hello', attachmentNames: ['photo.png'], images: ['data:image/png;base64,IMAGE_BYTES'] },
      { id: 'assistant-1', role: 'assistant', content: 'Answer with **formatting**.\n' },
    ],
  });
  return parseChatHistory({ version: 1, selectedId: 'conversation-1', conversations: [conversation] });
}

it('round-trips the full JSON history and strips unexpected credential fields', () => {
  const exported = serializeChatHistoryJson(sample());
  const imported = parseChatHistoryImport(exported);
  expect(imported.conversations[0]).toMatchObject({ id: 'conversation-1', pinnedAt: 3, webSearch: true });
  expect(imported.conversations[0].thread.messages[0]).toMatchObject({ id: 'user-1', images: ['data:image/png;base64,IMAGE_BYTES'] });

  const unsafe = JSON.parse(exported);
  unsafe.conversations[0].target.apiKey = 'api-key-secret';
  unsafe.conversations[0].target.accessToken = 'session-secret';
  const sanitized = serializeChatHistoryJson(parseChatHistory(unsafe));
  expect(sanitized).not.toContain('api-key-secret');
  expect(sanitized).not.toContain('session-secret');
  expect(sanitized).not.toContain('apiKey');
});

it('exports a readable Markdown transcript without binary media bytes and imports it back', () => {
  const markdown = serializeChatHistoryMarkdown(sample());
  expect(markdown).toContain('## A Markdown test');
  expect(markdown).toContain('> Hello');
  expect(markdown).toContain('> Answer with **formatting**.');
  expect(markdown).not.toContain('IMAGE_BYTES');

  const imported = parseChatHistoryImport(markdown);
  expect(imported.conversations).toHaveLength(1);
  expect(imported.conversations[0]).toMatchObject({ title: 'A Markdown test', pinnedAt: 3, webSearch: true });
  expect(imported.conversations[0].thread.messages).toMatchObject([
    { id: 'user-1', role: 'user', content: 'Hello\n<!-- aplot-message:AAAA -->\n> quoted', displayContent: 'Hello', attachmentNames: ['photo.png'] },
    { id: 'assistant-1', role: 'assistant', content: 'Answer with **formatting**.\n' },
  ]);
  expect(imported.conversations[0].thread.messages[0].images).toBeUndefined();
});

it('rejects malformed or unsupported JSON and arbitrary Markdown imports', () => {
  expect(() => parseChatHistoryImport('{broken')).toThrow('chat-import-invalid');
  expect(() => parseChatHistoryImport(JSON.stringify({ version: 2, selectedId: '', conversations: [] }))).toThrow('chat-import-invalid');
  expect(() => parseChatHistoryImport('# not an Aplot export')).toThrow('chat-import-invalid');
});
