import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import type { MobileMessage } from '../types';

interface MessageFeedProps {
  messages: MobileMessage[];
  loading: boolean;
  error?: string;
  pending?: boolean;
}

function safeLink(href?: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function messageTime(value?: string | number): string {
  if (value === undefined) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function resultText(message: MobileMessage): string {
  if (message.text?.trim()) return message.text;
  if (typeof message.result === 'string') return message.result.trim() ? message.result : '';
  if (message.result !== undefined && message.result !== null) {
    if (isEmptyResult(message.result)) return '';
    try { return JSON.stringify(message.result, null, 2); } catch { return ''; }
  }
  return '';
}

function isEmptyResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(item =>
    item === null || item === undefined || (typeof item === 'string' && item.trim() === ''),
  );
}

function toolNameLabel(name?: string): string {
  const normalized = name?.toLowerCase().replace(/[-_\s]/g, '');
  if (normalized === 'websearch' || normalized === 'websearchcall') return 'Поиск в интернете';
  return name || 'Инструмент';
}

function isToolHistory(message: MobileMessage, pending: boolean): boolean {
  if (message.kind !== 'tool') return false;
  if (message.status === 'completed' || message.status === 'success') return true;
  return message.status === 'unknown' && !pending;
}

function toolStatusLabel(status?: string): string {
  switch (status) {
    case 'running': return 'Выполняется';
    case 'success':
    case 'completed': return 'Готово';
    case 'error':
    case 'failed': return 'Ошибка';
    case 'denied': return 'Отклонено';
    case 'interrupted': return 'Остановлено';
    default: return 'Статус неизвестен';
  }
}

function renderMessage(message: MobileMessage) {
  if (message.kind === 'tool') {
    const text = resultText(message);
    const finalStatus = message.status !== 'running';
    return (
      <article className="tool-card" key={message.id}>
        <div className="tool-card-heading">
          <span className={`tool-status tool-status-${message.status ?? 'unknown'}`} aria-hidden="true" />
          <strong>{toolNameLabel(message.name)}</strong>
          <span className="tool-status-label">{toolStatusLabel(message.status)}</span>
        </div>
        {text && (finalStatus
          ? <details className="tool-result"><summary>Показать результат</summary><pre className="tool-card-content">{text}</pre></details>
          : <pre className="tool-card-content">{text}</pre>)}
      </article>
    );
  }

  const isUser = message.kind === 'user';
  return (
    <article className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'}`} key={message.id}>
      {!isUser && <div className="message-author">Aplot</div>}
      {isUser
        ? <p className="plain-message">{message.text ?? ''}</p>
        : <div className="markdown-message"><ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: () => null,
              a: ({ href, children }) => {
                const link = safeLink(href);
                return link
                  ? <a href={link} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{children}</a>
                  : <span>{children}</span>;
              },
            }}
          >{message.text ?? ''}</ReactMarkdown></div>}
      {message.reasoning && <details className="reasoning-block"><summary>Ход мыслей</summary><pre>{message.reasoning}</pre></details>}
      {message.time !== undefined && <time className="message-time">{messageTime(message.time)}</time>}
    </article>
  );
}

export function MessageFeed({ messages, loading, error, pending = false }: MessageFeedProps) {
  if (loading && messages.length === 0) {
    return <div className="chat-state" role="status">Загружаем историю…</div>;
  }
  if (error && messages.length === 0) {
    return <div className="chat-state chat-state-error" role="alert">{error}</div>;
  }
  if (messages.length === 0) {
    return <div className="chat-state"><span className="empty-orbit" aria-hidden="true">✦</span><p>Начните задачу сообщением ниже.</p></div>;
  }

  const entries: ReactNode[] = [];
  for (let index = 0; index < messages.length;) {
    if (isToolHistory(messages[index], pending)) {
      const start = index;
      while (index < messages.length && isToolHistory(messages[index], pending)) index += 1;
      const group = messages.slice(start, index);
      entries.push(
        <details className="tool-history-group" key={`tools-${group[0].id}`}>
          <summary>Действия агента · {group.length}</summary>
          <div className="tool-history-items">{group.map(renderMessage)}</div>
        </details>,
      );
      continue;
    }
    entries.push(renderMessage(messages[index]));
    index += 1;
  }

  return <div className="message-list" aria-label="История задачи">{entries}</div>;
}
