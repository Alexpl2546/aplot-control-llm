import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import { CHAT_HISTORY_STORAGE_KEY, parseChatHistory, type ChatHistoryChanges, type ChatHistoryData } from '../features/chat/historyModel';

export async function loadChatHistory(): Promise<ChatHistoryData> {
  const raw = isTauri() ? await invoke<unknown>('chat_history_load') : JSON.parse(localStorage.getItem(CHAT_HISTORY_STORAGE_KEY) ?? '{"version":1,"selectedId":"","conversations":[]}');
  return parseChatHistory(raw);
}
export async function saveChatHistory(changes: ChatHistoryChanges): Promise<void> {
  const temporaryIds = new Set(changes.conversations.filter(item => item.temporary).map(item => item.id));
  const safeChanges: ChatHistoryChanges = {
    selectedId: temporaryIds.has(changes.selectedId) ? '' : changes.selectedId,
    conversations: changes.conversations.filter(item => !item.temporary),
    deleted: changes.deleted.filter(id => !temporaryIds.has(id)),
  };
  if (isTauri()) { await invoke('chat_history_save', { changes: safeChanges }); return; }
  const previous = await loadChatHistory(), conversations = new Map(previous.conversations.map(item => [item.id, item]));
  for (const id of safeChanges.deleted) conversations.delete(id);
  for (const item of safeChanges.conversations) conversations.set(item.id, item);
  localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, selectedId: safeChanges.selectedId, conversations: [...conversations.values()] }));
}
