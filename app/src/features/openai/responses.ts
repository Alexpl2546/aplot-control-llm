import type { ChatDelta } from '../chat/stream';

/** Responses SSE is not Chat Completions SSE. Completion is an explicit event. */
export function responsesStream(onDelta: (delta: ChatDelta) => void) {
  const decoder = new TextDecoder(); let buffer = '', completed = false, failure = '';
  const consume = (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event.type === 'response.output_text.delta') onDelta({ content: String(event.delta ?? '') });
    if (event.type === 'response.completed') completed = true;
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) failure = 'streamError';
  };
  return {
    push(bytes: Uint8Array) { buffer = (buffer+decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n'); if (buffer.length > 2_000_000) throw new Error('limit'); let end; while ((end = buffer.indexOf('\n\n')) !== -1) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); } },
    finish() { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); if (failure) throw new Error(failure); if (!completed) throw new Error('incomplete'); },
  };
}
