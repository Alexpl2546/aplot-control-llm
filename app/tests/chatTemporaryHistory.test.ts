// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_HISTORY_STORAGE_KEY, parseChatHistory, savedConversation, type ChatTarget } from '../src/features/chat/historyModel';
import { flushChatHistory, initializeChatHistory } from '../src/features/chat/history';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import { parseChatHistoryImport, serializeChatHistoryJson, serializeChatHistoryMarkdown } from '../src/features/chat/historyTransfer';
import { loadChatHistory, saveChatHistory } from '../src/services/chatHistory';

const target: ChatTarget = { provider: 'local', runId: 'run-one', generation: 1, modelId: 'model.gguf', startedAt: '2026-11-01T10:00:00Z', label: 'Local model' };

beforeEach(async () => {
  await flushChatHistory();
  localStorage.clear();
  useChatStore.setState({ threads: {}, conversations: {}, selectedId: '', historyReady: false, historyError: '' });
  await initializeChatHistory();
});

afterEach(async () => {
  await flushChatHistory();
  vi.restoreAllMocks();
});

describe('temporary chat history isolation', () => {
  it('excludes temporary IDs, content, attachment bytes, and selection from dirty, selection, and deletion writes', async () => {
    const savedId = useChatStore.getState().create(target);
    useChatStore.getState().update(savedId, thread => ({ ...thread, messages: [{ role: 'user', content: 'saved question' }] }));
    await flushChatHistory();

    const write = vi.spyOn(Storage.prototype, 'setItem');
    const temporaryId = useChatStore.getState().createTemporary(target);
    useChatStore.getState().update(temporaryId, thread => ({
      ...thread,
      draft: 'temporary secret draft',
      messages: [{ role: 'user', content: 'temporary secret answer context', images: ['data:image/png;base64,TEMP_IMAGE_BYTES'] }],
    }));
    await flushChatHistory();
    useChatStore.getState().update(temporaryId, thread => ({ ...thread, draft: 'edited temporary secret' }));
    await flushChatHistory();
    useChatStore.getState().remove(temporaryId);
    await flushChatHistory();

    const stored = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY) ?? '';
    expect(JSON.parse(stored).conversations.map((item: { id: string }) => item.id)).toEqual([savedId]);
    expect(stored).not.toContain(temporaryId);
    expect(stored).not.toContain('temporary secret');
    expect(stored).not.toContain('TEMP_IMAGE_BYTES');
    for (const [, value] of write.mock.calls) {
      expect(value).not.toContain(temporaryId);
      expect(value).not.toContain('temporary secret');
      expect(value).not.toContain('TEMP_IMAGE_BYTES');
    }
  });

  it('omits temporary chats from direct exports, direct saves, and untrusted imports', async () => {
    const savedId = useChatStore.getState().create(target);
    useChatStore.getState().update(savedId, thread => ({ ...thread, messages: [{ role: 'user', content: 'saved record' }] }));
    await flushChatHistory();
    const saved = await loadChatHistory();
    const savedConversation = saved.conversations.find(item => item.id === savedId)!;
    const tempId = 'ephemeral-direct-id';
    const temp = {
      ...savedConversation,
      id: tempId,
      temporary: true,
      thread: { ...savedConversation.thread, messages: [{ role: 'user' as const, content: 'direct temporary secret' }] },
    };

    const json = serializeChatHistoryJson({ version: 1, selectedId: tempId, conversations: [temp, savedConversation] });
    const markdown = serializeChatHistoryMarkdown({ version: 1, selectedId: tempId, conversations: [temp, savedConversation] });
    expect(json).not.toContain(tempId);
    expect(json).not.toContain('direct temporary secret');
    expect(markdown).not.toContain(tempId);
    expect(markdown).not.toContain('direct temporary secret');
    expect(JSON.parse(json).selectedId).toBe(savedId);

    const imported = parseChatHistoryImport(JSON.stringify({ version: 1, selectedId: tempId, conversations: [temp, savedConversation] }));
    expect(imported.conversations.map(item => item.id)).toEqual([savedId]);
    expect(imported.conversations[0]).not.toHaveProperty('temporary');
    expect(() => savedConversationFactory(temp)).toThrow('temporary-chat-not-savable');

    await saveChatHistory({ selectedId: tempId, conversations: [temp], deleted: [] });
    const stored = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY) ?? '';
    expect(stored).not.toContain(tempId);
    expect(stored).not.toContain('direct temporary secret');
  });

  it('never marks imported temporary data as temporary in memory', () => {
    const imported = parseChatHistory({
      version: 1,
      selectedId: 'untrusted-temporary',
      conversations: [{
        id: 'untrusted-temporary', title: 'Imported', createdAt: 1, updatedAt: 1, temporary: true, target,
        thread: { messages: [{ role: 'user', content: 'untrusted data' }], draft: '', error: '', stopped: false, pending: false, translating: false },
      }],
    });
    expect(imported.conversations).toEqual([]);
    expect(imported.selectedId).toBe('');
  });
});

// The savedConversation import is aliased here to keep the test helper name clear.
function savedConversationFactory(value: Parameters<typeof savedConversation>[0]) {
  return savedConversation(value, EMPTY_THREAD);
}
