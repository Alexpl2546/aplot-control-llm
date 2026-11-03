import type { ChatAttachment } from './media';
import type { ChatMessage } from './stream';
import type { ChatThread } from './store';
import { normalizeContentBlock, type ContentBlock, type ChatUsage } from './content';

function savedBlocks(blocks?: ContentBlock[]): ContentBlock[] | undefined {
  return blocks?.map((block, index) => normalizeContentBlock(block, `block-${index}`)).filter((block): block is ContentBlock => !!block).map(block => block.type === 'tool' && block.status === 'in_progress' ? { ...block, status: 'incomplete' as const } : block);
}
function validUsage(value: unknown): value is ChatUsage {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, count]) => ['inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens'].includes(key) && Number.isSafeInteger(count) && Number(count) >= 0);
}

export type ChatTarget =
  | { provider: 'local'; runId: string; generation: number; label: string; engine?: string; modelId?: string; startedAt?: string }
  | { provider: 'chatgpt' | 'claude'; connectionId: string; profileId?: string; model: string; label: string };
export interface ChatConversation {
  id: string; title: string; createdAt: number; updatedAt: number; target: ChatTarget;
  /** Ephemeral session-only chat; this marker is never serialized. */
  temporary?: boolean;
  pinnedAt?: number; archivedAt?: number; projectId?: string;
  branchParentId?: string; branchFromMessageId?: string;
  instructions?: string; webSearch?: boolean;
}
export interface SavedConversation extends ChatConversation { thread: ChatThread; }
export interface ChatHistoryData { version: 1; selectedId: string; conversations: SavedConversation[]; }
export interface ChatHistoryChanges { selectedId: string; conversations: SavedConversation[]; deleted: string[]; }
export const CHAT_HISTORY_STORAGE_KEY = 'aplot.chat-history.v1';

export function createChatMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Assign IDs once when old records enter memory; later edits keep the existing IDs. */
export function ensureChatMessageIds(messages: ChatMessage[]): ChatMessage[] {
  const used = new Set<string>();
  let changed = false;
  const next = messages.map(message => {
    const id = message.id;
    if (typeof id === 'string' && id.trim() && !used.has(id)) { used.add(id); return message; }
    const newId = createChatMessageId();
    used.add(newId); changed = true;
    return { ...message, id: newId };
  });
  return changed ? next : messages;
}

/** Rebuild resendable attachments from a saved user message when it has enough data. */
export function attachmentsFromMessage(message: ChatMessage): ChatAttachment[] {
  const result: ChatAttachment[] = [];
  const images = message.images ?? [];
  const media = message.media ?? [];
  if (media.length) {
    media.forEach((item, index) => {
      const nextIndex = media[index + 1]?.imageIndex ?? images.length;
      const frames = images.slice(item.imageIndex, Math.max(item.imageIndex, nextIndex));
      if (item.kind === 'image') {
        const data = images[item.imageIndex];
        if (data) result.push({ id: createChatMessageId(), name: item.name, kind: 'image', data });
      } else result.push({ id: createChatMessageId(), name: item.name, kind: 'video', path: item.path, frames });
    });
  } else {
    images.forEach((data, index) => result.push({ id: createChatMessageId(), name: message.attachmentNames?.[index] ?? `image-${index + 1}`, kind: 'image', data }));
  }
  for (const document of message.documents ?? []) result.push({ id: createChatMessageId(), name: document.name, kind: 'file', data: document.data });

  const attachmentText = message.attachmentText ?? legacyAttachmentText(message);
  for (const name of message.attachmentNames ?? []) {
    if (result.some(item => item.name === name)) continue;
    const extracted = attachmentTextForName(attachmentText, name);
    if (extracted) result.push({ id: createChatMessageId(), name, kind: extracted.kind, text: extracted.text });
  }
  return result;
}

function legacyAttachmentText(message: ChatMessage): string {
  const display = message.displayContent ?? '';
  if (message.content.startsWith(display)) return message.content.slice(display.length).replace(/^\s+/, '');
  return '';
}
function attachmentTextForName(text: string, name: string): { kind: 'file' | 'skill'; text: string } | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(?:Attached file \\(quoted data\\)|User-selected skill instructions): ${escaped}\\n([\\s\\S]*?)(?=\\n\\n(?:Attached file \\(quoted data\\)|User-selected skill instructions): |$)`);
  const match = expression.exec(text);
  if (!match) return undefined;
  return { kind: match[0].startsWith('User-selected skill instructions') ? 'skill' : 'file', text: match[1] ?? '' };
}

export function sameChatTarget(a: ChatTarget, b: ChatTarget): boolean {
  return a.provider === 'local' ? b.provider === 'local' && a.runId === b.runId && a.generation === b.generation && a.modelId === b.modelId && a.startedAt === b.startedAt
    : b.provider !== 'local' && a.provider === b.provider && a.connectionId === b.connectionId && a.profileId === b.profileId && a.model === b.model;
}
/** Only explicitly listed conversation data reaches storage; launch configs and credentials never do. */
export function savedConversation(conversation: ChatConversation, thread: ChatThread): SavedConversation {
  if (conversation.temporary) throw new Error('temporary-chat-not-savable');
  const raw = conversation.target;
  const target: ChatTarget = raw.provider === 'local'
    ? { provider: raw.provider, runId: raw.runId, generation: raw.generation, label: raw.label, engine: raw.engine, modelId: raw.modelId, startedAt: raw.startedAt }
    : { provider: raw.provider, connectionId: raw.connectionId, profileId: raw.profileId, model: raw.model, label: raw.label };
  return {
    id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, target,
    ...(conversation.pinnedAt !== undefined ? { pinnedAt: conversation.pinnedAt } : {}),
    ...(conversation.archivedAt !== undefined ? { archivedAt: conversation.archivedAt } : {}),
    ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
    ...(conversation.branchParentId ? { branchParentId: conversation.branchParentId } : {}),
    ...(conversation.branchFromMessageId ? { branchFromMessageId: conversation.branchFromMessageId } : {}),
    ...(conversation.instructions !== undefined ? { instructions: conversation.instructions } : {}),
    ...(conversation.webSearch !== undefined ? { webSearch: conversation.webSearch } : {}),
    thread: {
      draft: thread.draft, error: thread.error, stopped: thread.stopped || thread.pending, pending: false, translating: false,
      messages: ensureChatMessageIds(thread.messages).map(message => ({
        id: message.id, role: message.role, content: message.content, displayContent: message.displayContent,
        attachmentText: message.attachmentText,
        ...(message.blocks ? { blocks: savedBlocks(message.blocks) } : {}),
        ...(message.usage && validUsage(message.usage) ? { usage: { ...message.usage } } : {}),
        images: message.images, documents: message.documents?.map(document => ({ name: document.name, data: document.data })),
        attachmentNames: message.attachmentNames, reasoning: message.reasoning, reasoningRu: message.reasoningRu,
        generationTps: message.generationTps,
        media: message.media?.map(item => ({ name: item.name, kind: item.kind, imageIndex: item.imageIndex, path: item.path })),
        reasoningTranslation: message.reasoningTranslation === 'pending' ? 'stopped' : message.reasoningTranslation,
      })),
      attachments: thread.attachments?.map(attachment => ({ id: attachment.id, name: attachment.name, kind: attachment.kind, data: attachment.data, text: attachment.text, frames: attachment.frames, path: attachment.path })),
    },
  };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown) => value === undefined || Array.isArray(value) && value.every(item => typeof item === 'string');
const optionalText = (value: unknown) => value === undefined || typeof value === 'string';
function message(value: unknown): value is ChatMessage {
  return object(value) && ['user', 'assistant'].includes(String(value.role)) && typeof value.content === 'string'
    && (value.id === undefined || typeof value.id === 'string' && value.id.trim().length > 0 && value.id.length <= 128)
    && optionalText(value.attachmentText)
    && (value.blocks === undefined || Array.isArray(value.blocks) && value.blocks.length <= 256 && value.blocks.every(block => object(block) && JSON.stringify(block).length <= 100000))
    && (value.usage === undefined || validUsage(value.usage))
    && (value.generationTps === undefined || typeof value.generationTps === 'number' && Number.isFinite(value.generationTps) && value.generationTps >= 0)
    && (value.media === undefined || Array.isArray(value.media) && value.media.every(item => object(item) && typeof item.name === 'string'
      && ['image', 'video'].includes(String(item.kind)) && Number.isSafeInteger(item.imageIndex) && Number(item.imageIndex) >= 0 && optionalText(item.path)))
    && ['displayContent', 'reasoning', 'reasoningRu'].every(key => optionalText(value[key])) && strings(value.images) && strings(value.attachmentNames)
    && (value.reasoningTranslation === undefined || ['pending', 'stopped', 'done', 'failed'].includes(String(value.reasoningTranslation)))
    && (value.documents === undefined || Array.isArray(value.documents) && value.documents.every(item => object(item) && typeof item.name === 'string' && typeof item.data === 'string'));
}
function attachment(value: unknown): value is ChatAttachment {
  return object(value) && typeof value.id === 'string' && typeof value.name === 'string' && ['image', 'file', 'video', 'skill'].includes(String(value.kind))
    && optionalText(value.data) && optionalText(value.text) && optionalText(value.path) && strings(value.frames);
}
export function parseChatHistory(raw: unknown): ChatHistoryData {
  if (!object(raw) || raw.version !== 1 || typeof raw.selectedId !== 'string' || !Array.isArray(raw.conversations)) throw new Error('chat-history-invalid');
  const ids = new Set<string>();
  // A temporary marker supplied by an import or stale storage entry never
  // creates a temporary in-memory conversation. Temporary content is omitted.
  const savedItems = raw.conversations.filter(value => !(object(value) && value.temporary === true));
  const conversations = savedItems.map(value => {
    if (!object(value) || typeof value.id !== 'string' || !value.id || ids.has(value.id) || typeof value.title !== 'string'
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
      || !object(value.target) || !object(value.thread)
      || ['pinnedAt', 'archivedAt'].some(key => value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key] as number)))
      || ['projectId', 'branchParentId', 'branchFromMessageId'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || (value[key] as string).length > 128))
      || value.instructions !== undefined && (typeof value.instructions !== 'string' || new TextEncoder().encode(value.instructions).length > 32_000)
      || value.webSearch !== undefined && typeof value.webSearch !== 'boolean') throw new Error('chat-history-invalid');
    const target = value.target, thread = value.thread;
    if (typeof target.label !== 'string' || (target.provider === 'local'
      ? typeof target.runId !== 'string' || !Number.isSafeInteger(target.generation) || Number(target.generation) < 0 || !optionalText(target.engine) || !optionalText(target.modelId) || !optionalText(target.startedAt)
      : !['chatgpt', 'claude'].includes(String(target.provider)) || typeof target.connectionId !== 'string' || typeof target.model !== 'string' || !optionalText(target.profileId))
      || typeof thread.draft !== 'string' || typeof thread.error !== 'string' || !Array.isArray(thread.messages) || !thread.messages.every(message)
      || (thread.attachments !== undefined && (!Array.isArray(thread.attachments) || !thread.attachments.every(attachment)))) throw new Error('chat-history-invalid');
    ids.add(value.id);
    const conversation: ChatConversation = {
      id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt, target: target as unknown as ChatTarget,
      ...(typeof value.pinnedAt === 'number' ? { pinnedAt: value.pinnedAt } : {}),
      ...(typeof value.archivedAt === 'number' ? { archivedAt: value.archivedAt } : {}),
      ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
      ...(typeof value.branchParentId === 'string' ? { branchParentId: value.branchParentId } : {}),
      ...(typeof value.branchFromMessageId === 'string' ? { branchFromMessageId: value.branchFromMessageId } : {}),
      ...(typeof value.instructions === 'string' ? { instructions: value.instructions } : {}),
      ...(typeof value.webSearch === 'boolean' ? { webSearch: value.webSearch } : {}),
    };
    const normalizedThread = { ...thread, messages: ensureChatMessageIds(thread.messages as ChatMessage[]), pending: false, translating: false, stopped: !!thread.stopped || !!thread.pending } as ChatThread;
    return savedConversation(conversation, normalizedThread);
  });
  return { version: 1, selectedId: ids.has(raw.selectedId) ? raw.selectedId : conversations[0]?.id ?? '', conversations };
}
