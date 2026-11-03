import { parseChatHistory, type ChatHistoryData } from './historyModel';

const MAX_IMPORT_CHARACTERS = 128 * 1024 * 1024;

export function serializeChatHistoryJson(data: ChatHistoryData): string {
  return JSON.stringify(parseChatHistory(data), null, 2);
}

/** Human-readable transcript export. Media bytes and credentials are never added to Markdown. */
export function serializeChatHistoryMarkdown(data: ChatHistoryData): string {
  const normalized = parseChatHistory(data);
  const output = ['# Aplot Chat History', '', '<!-- aplot-chat-export:v1 -->', ''];
  for (const conversation of normalized.conversations) {
    const { thread, ...metadata } = conversation;
    output.push(`<!-- aplot-conversation:${encodeMetadata(metadata)} -->`, `## ${markdownHeading(conversation.title || 'Untitled conversation')}`, '');
    for (const message of thread.messages) {
      const messageMetadata = {
        id: message.id, role: message.role, displayContent: message.displayContent,
        attachmentText: message.attachmentText, attachmentNames: message.attachmentNames,
      };
      output.push(`<!-- aplot-message:${encodeMetadata(messageMetadata)} -->`);
      output.push(...message.content.split('\n').map(line => line ? `> ${line}` : '>'), '<!-- aplot-message-end -->', '');
    }
    output.push('');
  }
  return output.join('\n').trimEnd() + '\n';
}

export function parseChatHistoryImport(text: string): ChatHistoryData {
  if (text.length > MAX_IMPORT_CHARACTERS) throw new Error('chat-import-limit');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { throw new Error('chat-import-invalid'); }
    try { return parseChatHistory(value); } catch { throw new Error('chat-import-invalid'); }
  }
  try { return parseMarkdownHistory(trimmed); } catch { throw new Error('chat-import-invalid'); }
}

function parseMarkdownHistory(text: string): ChatHistoryData {
  if (!text.startsWith('# Aplot Chat History') || !text.includes('<!-- aplot-chat-export:v1 -->')) throw new Error('chat-import-invalid');
  const lines = text.split(/\r?\n/);
  const conversations: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | undefined;
  let messages: Record<string, unknown>[] = [];
  let activeMessage: Record<string, unknown> | undefined;
  let body: string[] = [];
  const finishMessage = () => {
    if (!activeMessage) return;
    const content = body.map(line => line === '>' ? '' : line.startsWith('> ') ? line.slice(2) : '').join('\n');
    messages.push({ ...activeMessage, content });
    activeMessage = undefined; body = [];
  };
  const finishConversation = () => {
    if (!current) return;
    finishMessage();
    current.thread = { messages, draft: '', error: '', stopped: false, pending: false, translating: false };
    conversations.push(current);
    current = undefined; messages = [];
  };
  for (const line of lines) {
    const conversation = /^<!-- aplot-conversation:([A-Za-z0-9+/=]+) -->$/.exec(line);
    if (conversation) {
      finishConversation();
      current = decodeMetadata(conversation[1]!);
      continue;
    }
    const message = /^<!-- aplot-message:([A-Za-z0-9+/=]+) -->$/.exec(line);
    if (message) {
      if (!current) throw new Error('chat-import-invalid');
      finishMessage();
      activeMessage = decodeMetadata(message[1]!);
      continue;
    }
    if (line === '<!-- aplot-message-end -->') { finishMessage(); continue; }
    if (activeMessage) body.push(line);
  }
  finishConversation();
  if (!conversations.length) throw new Error('chat-import-invalid');
  return parseChatHistory({ version: 1, selectedId: '', conversations });
}

function encodeMetadata(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeMetadata(value: string): Record<string, unknown> {
  try {
    const binary = atob(value), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
    return decoded as Record<string, unknown>;
  } catch { throw new Error('chat-import-invalid'); }
}
function markdownHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}
