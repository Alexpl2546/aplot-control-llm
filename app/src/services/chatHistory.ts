import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import { CHAT_HISTORY_STORAGE_KEY, parseChatHistory, type ChatHistoryChanges, type ChatHistoryData } from '../features/chat/historyModel';

export async function loadChatHistory(): Promise<ChatHistoryData> {
  const raw = isTauri() ? await invoke<unknown>('chat_history_load') : JSON.parse(localStorage.getItem(CHAT_HISTORY_STORAGE_KEY) ?? '{"version":1,"selectedId":"","conversations":[]}');
  return parseChatHistory(raw);
}
export async function saveChatHistory(changes: ChatHistoryChanges): Promise<void> {
  if (isTauri()) { await invoke('chat_history_save', { changes }); return; }
  const previous = await loadChatHistory(), conversations = new Map(previous.conversations.map(item => [item.id, item]));
  for (const id of changes.deleted) conversations.delete(id);
  for (const item of changes.conversations) conversations.set(item.id, item);
  localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, selectedId: changes.selectedId, conversations: [...conversations.values()] }));
}
