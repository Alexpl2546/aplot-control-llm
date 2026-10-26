import type { ChatAttachment } from './media';
import type { ChatMessage } from './stream';
import type { ChatThread } from './store';

export type ChatTarget =
  | { provider: 'local'; runId: string; generation: number; label: string; engine?: string; modelId?: string; startedAt?: string }
  | { provider: 'chatgpt' | 'claude'; connectionId: string; profileId?: string; model: string; label: string };
export interface ChatConversation { id: string; title: string; createdAt: number; updatedAt: number; target: ChatTarget; }
export interface SavedConversation extends ChatConversation { thread: ChatThread; }
export interface ChatHistoryData { version: 1; selectedId: string; conversations: SavedConversation[]; }
export interface ChatHistoryChanges { selectedId: string; conversations: SavedConversation[]; deleted: string[]; }
export const CHAT_HISTORY_STORAGE_KEY = 'aplot.chat-history.v1';

export function sameChatTarget(a: ChatTarget, b: ChatTarget): boolean {
  return a.provider === 'local' ? b.provider === 'local' && a.runId === b.runId && a.generation === b.generation && a.modelId === b.modelId && a.startedAt === b.startedAt
    : b.provider !== 'local' && a.provider === b.provider && a.connectionId === b.connectionId && a.profileId === b.profileId && a.model === b.model;
}
/** Only explicitly listed conversation data reaches storage; launch configs and credentials never do. */
export function savedConversation(conversation: ChatConversation, thread: ChatThread): SavedConversation {
  const raw = conversation.target;
  const target: ChatTarget = raw.provider === 'local'
    ? { provider: raw.provider, runId: raw.runId, generation: raw.generation, label: raw.label, engine: raw.engine, modelId: raw.modelId, startedAt: raw.startedAt }
    : { provider: raw.provider, connectionId: raw.connectionId, profileId: raw.profileId, model: raw.model, label: raw.label };
  return {
    id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, target,
    thread: {
      draft: thread.draft, error: thread.error, stopped: thread.stopped || thread.pending, pending: false, translating: false,
      messages: thread.messages.map(message => ({
        role: message.role, content: message.content, displayContent: message.displayContent,
        images: message.images, documents: message.documents?.map(document => ({ name: document.name, data: document.data })),
        attachmentNames: message.attachmentNames, reasoning: message.reasoning, reasoningRu: message.reasoningRu,
        reasoningTranslation: message.reasoningTranslation === 'pending' ? 'stopped' : message.reasoningTranslation,
      })),
      attachments: thread.attachments?.map(attachment => ({ id: attachment.id, name: attachment.name, kind: attachment.kind, data: attachment.data, text: attachment.text, frames: attachment.frames })),
    },
  };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown) => value === undefined || Array.isArray(value) && value.every(item => typeof item === 'string');
const optionalText = (value: unknown) => value === undefined || typeof value === 'string';
function message(value: unknown): value is ChatMessage {
  return object(value) && ['user', 'assistant'].includes(String(value.role)) && typeof value.content === 'string'
    && ['displayContent', 'reasoning', 'reasoningRu'].every(key => optionalText(value[key])) && strings(value.images) && strings(value.attachmentNames)
    && (value.reasoningTranslation === undefined || ['pending', 'stopped', 'done', 'failed'].includes(String(value.reasoningTranslation)))
    && (value.documents === undefined || Array.isArray(value.documents) && value.documents.every(item => object(item) && typeof item.name === 'string' && typeof item.data === 'string'));
}
function attachment(value: unknown): value is ChatAttachment {
  return object(value) && typeof value.id === 'string' && typeof value.name === 'string' && ['image', 'file', 'video', 'skill'].includes(String(value.kind))
    && optionalText(value.data) && optionalText(value.text) && strings(value.frames);
}
export function parseChatHistory(raw: unknown): ChatHistoryData {
  if (!object(raw) || raw.version !== 1 || typeof raw.selectedId !== 'string' || !Array.isArray(raw.conversations)) throw new Error('chat-history-invalid');
  const ids = new Set<string>();
  const conversations = raw.conversations.map(value => {
    if (!object(value) || typeof value.id !== 'string' || !value.id || ids.has(value.id) || typeof value.title !== 'string'
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
      || !object(value.target) || !object(value.thread)) throw new Error('chat-history-invalid');
    const target = value.target, thread = value.thread;
    if (typeof target.label !== 'string' || (target.provider === 'local'
      ? typeof target.runId !== 'string' || !Number.isSafeInteger(target.generation) || Number(target.generation) < 0 || !optionalText(target.engine) || !optionalText(target.modelId) || !optionalText(target.startedAt)
      : !['chatgpt', 'claude'].includes(String(target.provider)) || typeof target.connectionId !== 'string' || typeof target.model !== 'string' || !optionalText(target.profileId))
      || typeof thread.draft !== 'string' || typeof thread.error !== 'string' || !Array.isArray(thread.messages) || !thread.messages.every(message)
      || (thread.attachments !== undefined && (!Array.isArray(thread.attachments) || !thread.attachments.every(attachment)))) throw new Error('chat-history-invalid');
    ids.add(value.id);
    return savedConversation(value as unknown as ChatConversation, { ...thread, pending: false, translating: false, stopped: !!thread.stopped || !!thread.pending } as ChatThread);
  });
  return { version: 1, selectedId: ids.has(raw.selectedId) ? raw.selectedId : conversations[0]?.id ?? '', conversations };
}
