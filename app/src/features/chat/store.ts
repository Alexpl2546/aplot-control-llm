import { create } from 'zustand';
import type { ChatAttachment } from './media';
import type { ChatMessage } from './stream';
import { attachmentsFromMessage, ensureChatMessageIds, sameChatTarget, type ChatConversation, type ChatTarget, type SavedConversation } from './historyModel';

export interface ChatThread {attachments?:ChatAttachment[]; messages: ChatMessage[]; draft: string; error: string; stopped: boolean; pending: boolean; translating: boolean; }
export const EMPTY_THREAD: ChatThread = { messages: [], draft: '', error: '', stopped: false, pending: false, translating: false };
/** Nothing sent, nothing typed, nothing attached. */
export const isBlankThread = (thread?: ChatThread) => !thread || (!thread.messages.length && !thread.pending && !thread.draft.trim() && !thread.attachments?.length);
export const useChatStore = create<{
  threads: Record<string, ChatThread>;
  conversations: Record<string, ChatConversation>;
  selectedId: string;
  historyReady: boolean;
  historyError: '' | 'load' | 'save';
  update: (id: string, edit: (thread: ChatThread) => ChatThread) => void;
  create: (target: ChatTarget) => string;
  createTemporary: (target: ChatTarget) => string;
  activate: (target: ChatTarget) => string;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  pin: (id: string, pinned: boolean) => void;
  archive: (id: string, archived: boolean) => void;
  forkFromMessage: (id: string, messageId: string, mode: 'through' | 'edit' | 'regenerate') => string;
  importConversations: (items: SavedConversation[]) => number;
  remove: (id: string) => void;
  restore: (conversation: ChatConversation, thread: ChatThread) => void;
}>((set, get) => ({
  threads: {}, conversations: {}, selectedId: '', historyReady: false, historyError: '',
  update: (id, edit) => set(s => {
    const previous = s.threads[id] ?? EMPTY_THREAD, edited = edit(previous), thread = edited.messages === previous.messages ? edited : { ...edited, messages: ensureChatMessageIds(edited.messages) }, conversation = s.conversations[id];
    if (thread === previous) return s;
    const firstQuestion = thread.messages.find(message => message.role === 'user');
    return {
      threads: { ...s.threads, [id]: thread },
      ...(conversation && thread.messages !== previous.messages ? { conversations: { ...s.conversations, [id]: { ...conversation, updatedAt: Date.now(), title: conversation.title || (firstQuestion?.displayContent || firstQuestion?.content || firstQuestion?.attachmentNames?.[0] || '').trim().replace(/\s+/g, ' ').slice(0, 80) } } } : {}),
    };
  }),
  create: target => {
    const id = crypto.randomUUID(), now = Date.now();
    // A conversation becomes real with its first message: untouched drafts are replaced, never piled up in history.
    set(s => {
      const conversations = { ...s.conversations }, threads = { ...s.threads };
      for (const key of Object.keys(conversations)) if (!conversations[key]!.title && isBlankThread(threads[key])) { delete conversations[key]; delete threads[key]; }
      return { selectedId: id, conversations: { ...conversations, [id]: { id, target, title: '', createdAt: now, updatedAt: now } }, threads: { ...threads, [id]: { ...EMPTY_THREAD } } };
    });
    return id;
  },
  createTemporary: target => {
    const id = crypto.randomUUID(), now = Date.now();
    set(s => ({
      conversations: { ...s.conversations, [id]: { id, title: '', createdAt: now, updatedAt: now, target, temporary: true } },
      threads: { ...s.threads, [id]: { ...EMPTY_THREAD } },
      selectedId: id,
    }));
    return id;
  },
  activate: target => {
    const existing = Object.values(get().conversations).filter(item => !item.temporary && !item.archivedAt && sameChatTarget(item.target, target)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) { set({ selectedId: existing.id }); return existing.id; }
    return get().create(target);
  },
  select: id => { if (get().conversations[id]) set({ selectedId: id }); },
  rename: (id, title) => set(s => s.conversations[id] && title.trim() ? { conversations: { ...s.conversations, [id]: { ...s.conversations[id], title: title.trim().slice(0, 120), updatedAt: Date.now() } } } : s),
  pin: (id, pinned) => set(s => {
    const conversation = s.conversations[id]; if (!conversation || conversation.temporary || (conversation.pinnedAt !== undefined) === pinned) return s;
    const { pinnedAt: _pinnedAt, ...unPinned } = conversation;
    const now = Date.now();
    return { conversations: { ...s.conversations, [id]: pinned ? { ...conversation, pinnedAt: now, updatedAt: now } : { ...unPinned, updatedAt: now } } };
  }),
  archive: (id, archived) => set(s => {
    const conversation = s.conversations[id]; if (!conversation || conversation.temporary || (conversation.archivedAt !== undefined) === archived) return s;
    const { archivedAt: _archivedAt, ...unArchived } = conversation;
    const now = Date.now();
    return { conversations: { ...s.conversations, [id]: archived ? { ...conversation, archivedAt: now, updatedAt: now } : { ...unArchived, updatedAt: now } } };
  }),
  forkFromMessage: (id, messageId, mode) => {
    const state = get(), source = state.conversations[id], thread = state.threads[id] ?? EMPTY_THREAD;
    const index = thread.messages.findIndex(message => message.id === messageId);
    if (!source || index < 0 || thread.pending || thread.translating) return '';
    const message = thread.messages[index]!;
    if (mode === 'edit' && message.role !== 'user' || mode === 'regenerate' && message.role !== 'assistant') return '';
    const messages = mode === 'through' ? thread.messages.slice(0, index + 1) : thread.messages.slice(0, index);
    const idForBranch = crypto.randomUUID(), now = Date.now();
    const branch: ChatConversation = {
      ...source, id: idForBranch, title: source.title, createdAt: now, updatedAt: now,
      branchParentId: source.id, branchFromMessageId: message.id,
      pinnedAt: undefined, archivedAt: undefined,
    };
    const copiedMessages = ensureChatMessageIds(structuredClone(messages));
    const branchThread: ChatThread = {
      ...structuredClone(thread), messages: copiedMessages,
      draft: mode === 'edit' ? message.displayContent ?? message.content : '',
      attachments: mode === 'edit' ? attachmentsFromMessage(message) : [],
      error: '', stopped: false, pending: false, translating: false,
    };
    set(current => ({
      conversations: { ...current.conversations, [idForBranch]: branch },
      threads: { ...current.threads, [idForBranch]: branchThread },
      selectedId: idForBranch,
    }));
    return idForBranch;
  },
  importConversations: items => {
    if (!items.length) return 0;
    const state = get(), ids = new Map(items.map(item => [item.id, crypto.randomUUID()]));
    const conversations = { ...state.conversations }, threads = { ...state.threads };
    for (const item of items) {
      const { thread, ...conversation } = item;
      const id = ids.get(item.id)!;
      const parentId = conversation.branchParentId ? ids.get(conversation.branchParentId) : undefined;
      conversations[id] = { ...conversation, id, ...(conversation.branchParentId ? { branchParentId: parentId ?? '' } : {}) };
      if (!parentId && conversation.branchParentId) delete conversations[id]!.branchParentId;
      threads[id] = { ...structuredClone(thread), messages: ensureChatMessageIds(structuredClone(thread.messages)), pending: false, translating: false };
    }
    set({ conversations, threads });
    return items.length;
  },
  restore: (conversation, thread) => set(s => s.conversations[conversation.id] ? s : { conversations: { ...s.conversations, [conversation.id]: conversation }, threads: { ...s.threads, [conversation.id]: { ...thread, messages: ensureChatMessageIds(thread.messages), pending: false, translating: false } }, selectedId: conversation.id }),
  remove: id => set(s => {
    if (!s.conversations[id] || s.threads[id]?.pending || s.threads[id]?.translating) return s;
    const conversations = { ...s.conversations }, threads = { ...s.threads };
    delete conversations[id]; delete threads[id];
    return { conversations, threads, selectedId: s.selectedId === id ? Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? '' : s.selectedId };
  }),
}));
