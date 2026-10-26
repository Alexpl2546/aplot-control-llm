import { loadChatHistory, saveChatHistory } from '../../services/chatHistory';
import { EMPTY_THREAD, useChatStore } from './store';
import { savedConversation } from './historyModel';

let initialization: Promise<void> | undefined, writing: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let selectionDirty = false;
const dirty = new Set<string>(), deleted = new Set<string>();

/** Errors during loading leave writes disabled so a corrupt/unavailable store is never overwritten. */
export function initializeChatHistory(): Promise<void> {
  if (useChatStore.getState().historyReady) return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const saved = await loadChatHistory();
      useChatStore.setState(state => ({
        conversations: { ...Object.fromEntries(saved.conversations.map(({ thread: _thread, ...conversation }) => [conversation.id, conversation])), ...state.conversations },
        threads: { ...Object.fromEntries(saved.conversations.map(conversation => [conversation.id, conversation.thread])), ...state.threads },
        selectedId: state.selectedId || saved.selectedId, historyReady: true, historyError: '',
      }));
    } catch { useChatStore.setState({ historyError: 'load' }); }
  })().finally(() => { initialization = undefined; });
  return initialization;
}

export async function flushChatHistory(): Promise<void> {
  if (timer) clearTimeout(timer); timer = undefined;
  if (writing) { await writing; if (!useChatStore.getState().historyError) await flushChatHistory(); return; }
  const state = useChatStore.getState();
  if (!state.historyReady || !selectionDirty && !dirty.size && !deleted.size) return;
  const ids = [...dirty], removed = [...deleted];
  const conversations = ids.flatMap(id => state.conversations[id] ? [savedConversation(state.conversations[id], state.threads[id] ?? EMPTY_THREAD)] : []);
  ids.forEach(id => dirty.delete(id)); removed.forEach(id => deleted.delete(id)); selectionDirty = false;
  writing = (async () => {
    try { await saveChatHistory({ selectedId: state.selectedId, conversations, deleted: removed }); useChatStore.setState({ historyError: '' }); }
    catch {
      ids.forEach(id => { if (useChatStore.getState().conversations[id]) dirty.add(id); });
      removed.forEach(id => deleted.add(id)); selectionDirty = true;
      useChatStore.setState({ historyError: 'save' });
    }
  })();
  await writing; writing = undefined;
  if (!useChatStore.getState().historyError && (selectionDirty || dirty.size || deleted.size)) await flushChatHistory();
}

useChatStore.subscribe((state, previous) => {
  if (!state.historyReady || !previous.historyReady) return;
  for (const [id, conversation] of Object.entries(state.conversations)) {
    if (conversation !== previous.conversations[id] || state.threads[id] !== previous.threads[id]) { dirty.add(id); deleted.delete(id); }
  }
  for (const id of Object.keys(previous.conversations)) if (!state.conversations[id]) { deleted.add(id); dirty.delete(id); }
  selectionDirty ||= state.selectedId !== previous.selectedId;
  if ((selectionDirty || dirty.size || deleted.size) && !timer && !state.historyError) timer = setTimeout(() => { timer = undefined; void flushChatHistory(); }, 400);
});
