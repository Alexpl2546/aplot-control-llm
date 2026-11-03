// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadChatHistory, saveChatHistory } from '../src/services/chatHistory';
import { initializeChatHistory, flushChatHistory } from '../src/features/chat/history';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import { CHAT_HISTORY_STORAGE_KEY, parseChatHistory, sameChatTarget, savedConversation, type ChatTarget } from '../src/features/chat/historyModel';

const target: ChatTarget = { provider: 'local', runId: 'profile:one', generation: 1, modelId: 'one.gguf', startedAt: '2026-10-22T12:00:00Z', label: 'My model' };
beforeEach(async () => {
  await flushChatHistory();
  useChatStore.setState({ threads: {}, conversations: {}, selectedId: '', historyReady: false, historyError: '' });
  localStorage.clear();
});
afterEach(async () => { vi.restoreAllMocks(); await flushChatHistory(); });

it('hydrates an empty first launch and preserves multiple conversations and drafts across restart', async () => {
  await initializeChatHistory();
  expect(useChatStore.getState()).toMatchObject({ historyReady: true, historyError: '', conversations: {} });
  const first = useChatStore.getState().create(target);
  useChatStore.getState().update(first, thread => ({ ...thread, draft: 'Unsent draft', messages: [{ role: 'user', content: 'Question one' }, { role: 'assistant', content: 'Answer one' }] }));
  const second = useChatStore.getState().create(target);
  useChatStore.getState().update(second, thread => ({ ...thread, messages: [{ role: 'user', content: '', images: ['data:image/png;base64,AA=='], attachmentNames: ['photo.png'] }] }));
  await flushChatHistory();
  useChatStore.setState({ threads: {}, conversations: {}, selectedId: '', historyReady: false });
  await initializeChatHistory();
  expect(Object.keys(useChatStore.getState().conversations)).toHaveLength(2);
  expect(useChatStore.getState().selectedId).toBe(second);
  expect(useChatStore.getState().threads[first]).toMatchObject({ draft: 'Unsent draft', messages: [{ content: 'Question one' }, { content: 'Answer one' }] });
  expect(useChatStore.getState().conversations[second].title).toBe('photo.png');
});

it('persists rename and deletion without deleting another conversation', async () => {
  await initializeChatHistory();
  const one = useChatStore.getState().create(target), two = useChatStore.getState().create({ provider: 'claude', connectionId: 'account', profileId: 'profile', model: 'model', label: 'Claude' });
  useChatStore.getState().rename(two, 'My cloud conversation');
  await flushChatHistory();
  useChatStore.getState().remove(one);
  await flushChatHistory();
  expect((await loadChatHistory()).conversations).toMatchObject([{ id: two, title: 'My cloud conversation', target: { provider: 'claude', connectionId: 'account' } }]);
});

it('restores interrupted replies and translations as stopped, never as active jobs', () => {
  const saved = savedConversation({ id: 'one', title: '', createdAt: 1, updatedAt: 2, target }, { ...EMPTY_THREAD, pending: true, translating: true, messages: [{ role: 'assistant', content: 'Partial', reasoning: 'Original analysis', reasoningTranslation: 'pending' }] });
  const restored = parseChatHistory({ version: 1, selectedId: 'one', conversations: [saved] });
  expect(restored.conversations[0].thread).toMatchObject({ pending: false, translating: false, stopped: true, messages: [{ content: 'Partial', reasoningTranslation: 'stopped' }] });
});

it('whitelists metadata and never persists credentials or launch settings', () => {
  const saved = savedConversation({ id: 'one', title: '', createdAt: 1, updatedAt: 2, target: { ...target, apiKey: 'secret', config: { apiKey: 'another-secret' } } as ChatTarget }, { ...EMPTY_THREAD, token: 'session-token' } as typeof EMPTY_THREAD);
  expect(JSON.stringify(saved)).not.toMatch(/secret|apiKey|session-token|config|token/);
});

it('does not overwrite saved data after a corrupt history or failed read', async () => {
  localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, '{broken-history');
  await initializeChatHistory();
  expect(useChatStore.getState()).toMatchObject({ historyReady: false, historyError: 'load' });
  useChatStore.getState().create(target);
  await flushChatHistory();
  expect(localStorage.getItem(CHAT_HISTORY_STORAGE_KEY)).toBe('{broken-history');
});

it('keeps messages in memory after quota errors and retries the unsaved changes', async () => {
  await initializeChatHistory();
  const id = useChatStore.getState().create(target);
  useChatStore.getState().update(id, thread => ({ ...thread, draft: 'Keep my draft' }));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  await flushChatHistory();
  expect(useChatStore.getState().historyError).toBe('save');
  expect(useChatStore.getState().threads[id].draft).toBe('Keep my draft');
  write.mockRestore();
  await flushChatHistory();
  expect(useChatStore.getState().historyError).toBe('');
  expect((await loadChatHistory()).conversations[0].thread.draft).toBe('Keep my draft');
});

it('treats different local launch identities and cloud connections as different targets', () => {
  expect(sameChatTarget(target, { ...target, startedAt: 'next-app-session' })).toBe(false);
  expect(sameChatTarget(target, { ...target, modelId: 'other.gguf' })).toBe(false);
  expect(sameChatTarget({ provider: 'chatgpt', connectionId: 'one', model: 'model', label: '' }, { provider: 'chatgpt', connectionId: 'two', model: 'model', label: '' })).toBe(false);
});

it('does not delete a conversation while its answer is streaming', async () => {
  await initializeChatHistory();
  const id = useChatStore.getState().create(target);
  useChatStore.getState().update(id, thread => ({ ...thread, pending: true }));
  useChatStore.getState().remove(id);
  expect(useChatStore.getState().conversations[id]).toBeDefined();
});

it('rejects unsupported history versions instead of replacing them with an empty document', async () => {
  localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify({ version: 2, selectedId: '', conversations: [] }));
  await expect(loadChatHistory()).rejects.toThrow('chat-history-invalid');
  await expect(saveChatHistory({ selectedId: '', conversations: [], deleted: [] })).rejects.toThrow('chat-history-invalid');
});

it('migrates legacy messages to stable IDs and keeps them across another parse', () => {
  const legacy = { version: 1, selectedId: 'old', conversations: [{ id: 'old', title: 'Old', createdAt: 1, updatedAt: 2, target,
    thread: { messages: [{ role: 'user', content: 'Legacy question' }], draft: '', error: '', stopped: false, pending: false, translating: false } }] };
  const migrated = parseChatHistory(legacy), firstId = migrated.conversations[0].thread.messages[0].id;
  expect(firstId).toBeTruthy();
  expect(parseChatHistory(migrated).conversations[0].thread.messages[0].id).toBe(firstId);
});

it('persists pin and archive state across a history reload', async () => {
  await initializeChatHistory();
  const id = useChatStore.getState().create(target);
  useChatStore.getState().update(id, thread => ({ ...thread, messages: [{ role: 'user', id: 'message-1', content: 'Keep this chat' }] }));
  useChatStore.getState().pin(id, true);
  useChatStore.getState().archive(id, true);
  await flushChatHistory();
  useChatStore.setState({ threads: {}, conversations: {}, selectedId: '', historyReady: false });
  await initializeChatHistory();
  expect(useChatStore.getState().conversations[id]).toMatchObject({ pinnedAt: expect.any(Number), archivedAt: expect.any(Number) });
});

it('activates an unarchived conversation instead of the most recent archived one', () => {
  const active = useChatStore.getState().create(target);
  useChatStore.getState().rename(active, 'Active');
  const archived = useChatStore.getState().create(target);
  useChatStore.getState().rename(archived, 'Archived');
  useChatStore.getState().archive(archived, true);
  expect(useChatStore.getState().activate(target)).toBe(active);
  expect(useChatStore.getState().conversations[archived].archivedAt).toBeDefined();
});

it('creates edit and regenerate branches without changing the source transcript', async () => {
  await initializeChatHistory();
  const id = useChatStore.getState().create(target);
  const messages = [
    { role: 'user' as const, id: 'user-1', content: 'First question' },
    { role: 'assistant' as const, id: 'assistant-1', content: 'First answer' },
    { role: 'user' as const, id: 'user-2', content: 'Second question', displayContent: 'Second question', images: ['data:image/png;base64,AA=='], attachmentNames: ['photo.png'] },
    { role: 'assistant' as const, id: 'assistant-2', content: 'Second answer' },
  ];
  useChatStore.getState().update(id, thread => ({ ...thread, messages }));
  const sourceMessages = useChatStore.getState().threads[id].messages;
  const editBranch = useChatStore.getState().forkFromMessage(id, 'user-2', 'edit');
  expect(useChatStore.getState().threads[id].messages).toBe(sourceMessages);
  expect(useChatStore.getState().threads[id].messages).toEqual(messages);
  expect(useChatStore.getState().conversations[editBranch]).toMatchObject({ branchParentId: id, branchFromMessageId: 'user-2' });
  expect(useChatStore.getState().threads[editBranch]).toMatchObject({ draft: 'Second question', messages: messages.slice(0, 2), attachments: [{ name: 'photo.png', kind: 'image', data: 'data:image/png;base64,AA==' }] });
  const retryBranch = useChatStore.getState().forkFromMessage(id, 'assistant-2', 'regenerate');
  expect(retryBranch).not.toBe(editBranch);
  expect(useChatStore.getState().threads[retryBranch].messages).toEqual(messages.slice(0, 3));
  expect(useChatStore.getState().threads[id].messages).toBe(sourceMessages);
});
