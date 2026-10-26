import { create } from 'zustand';
import type { ChatAttachment } from './media';
import type { ChatMessage } from './stream';
import { sameChatTarget, type ChatConversation, type ChatTarget } from './historyModel';

export interface ChatThread {attachments?:ChatAttachment[]; messages: ChatMessage[]; draft: string; error: string; stopped: boolean; pending: boolean; translating: boolean; }
export const EMPTY_THREAD: ChatThread = { messages: [], draft: '', error: '', stopped: false, pending: false, translating: false };
export const useChatStore = create<{
  threads: Record<string, ChatThread>;
  conversations: Record<string, ChatConversation>;
  selectedId: string;
  historyReady: boolean;
  historyError: '' | 'load' | 'save';
  update: (id: string, edit: (thread: ChatThread) => ChatThread) => void;
  create: (target: ChatTarget) => string;
  activate: (target: ChatTarget) => string;
  select: (id: string) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
}>((set, get) => ({
  threads: {}, conversations: {}, selectedId: '', historyReady: false, historyError: '',
  update: (id, edit) => set(s => {
    const previous = s.threads[id] ?? EMPTY_THREAD, thread = edit(previous), conversation = s.conversations[id];
    if (thread === previous) return s;
    const firstQuestion = thread.messages.find(message => message.role === 'user');
    return {
      threads: { ...s.threads, [id]: thread },
      ...(conversation && thread.messages !== previous.messages ? { conversations: { ...s.conversations, [id]: { ...conversation, updatedAt: Date.now(), title: conversation.title || (firstQuestion?.displayContent || firstQuestion?.content || firstQuestion?.attachmentNames?.[0] || '').trim().replace(/\s+/g, ' ').slice(0, 80) } } } : {}),
    };
  }),
  create: target => {
    const id = crypto.randomUUID(), now = Date.now();
    set(s => ({ selectedId: id, conversations: { ...s.conversations, [id]: { id, target, title: '', createdAt: now, updatedAt: now } }, threads: { ...s.threads, [id]: { ...EMPTY_THREAD } } }));
    return id;
  },
  activate: target => {
    const existing = Object.values(get().conversations).filter(item => sameChatTarget(item.target, target)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) { set({ selectedId: existing.id }); return existing.id; }
    return get().create(target);
  },
  select: id => { if (get().conversations[id]) set({ selectedId: id }); },
  rename: (id, title) => set(s => s.conversations[id] && title.trim() ? { conversations: { ...s.conversations, [id]: { ...s.conversations[id], title: title.trim().slice(0, 120), updatedAt: Date.now() } } } : s),
  remove: id => set(s => {
    if (!s.conversations[id] || s.threads[id]?.pending || s.threads[id]?.translating) return s;
    const conversations = { ...s.conversations }, threads = { ...s.threads };
    delete conversations[id]; delete threads[id];
    return { conversations, threads, selectedId: s.selectedId === id ? Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? '' : s.selectedId };
  }),
}));
