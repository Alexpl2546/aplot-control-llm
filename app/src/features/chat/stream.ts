export interface ChatMessage { role: 'user' | 'assistant'; content: string; images?:string[];documents?:{name:string;data:string}[];attachmentNames?:string[];displayContent?:string; reasoning?: string; reasoningRu?: string; reasoningTranslation?: 'pending' | 'done' | 'failed' | 'stopped'; }
export interface ChatDelta { content?: string; reasoning?: string; finishReason?: string; }

/** Handles UTF-8 splits, CRLF, multiple data lines and a final unterminated frame. */
export function chatStream(onDelta: (delta: ChatDelta) => void) {
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [], event = '', finished = false;
  const frame = () => {
    if (finished) return;
    const body = data.join('\n'); data = [];
    const isError = event === 'error'; event = '';
    if (!body.trim()) return;
    if (body.trim() === '[DONE]') { finished = true; return; }
    const payload = JSON.parse(body);
    if (isError || payload.error) throw new Error('streamError');
    const delta = payload.choices?.[0]?.delta;
    if (delta) onDelta({ content: typeof delta.content === 'string' ? delta.content : undefined, reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : undefined });
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (typeof finishReason === 'string') onDelta({ finishReason });
  };
  const line = (value: string) => {
    if (!value) frame();
    else if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
    else if (value.startsWith('event:')) event = value.slice(6).trim();
  };
  return {
    push(bytes: Uint8Array) {
      buffer += decoder.decode(bytes, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('streamError');
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const value of lines) line(value);
    },
    finish() { buffer += decoder.decode(); if (buffer) line(buffer); frame(); if (!finished) throw new Error('incomplete'); },
  };
}
