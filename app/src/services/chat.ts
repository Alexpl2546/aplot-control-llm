import { sendClaudeChat } from './claude';
import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import { chatStream, type ChatDelta, type ChatMessage } from '../features/chat/stream';
import { responsesStream } from '../features/openai/responses';

export interface ChatRequest { runId: string; generation: number; messages: ChatMessage[]; maxTokens: number; temperature: number; purpose?: 'reasoningTranslation'; cloud?:{connectionId:string;model:string;provider?:'chatgpt'|'claude'}; }

export async function sendChat(request: ChatRequest, onDelta: (delta: ChatDelta) => void, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  // Browser preview has no access to live model servers or stored credentials.
  if (!isTauri()) {
    if (!request.purpose) onDelta({ reasoning: "Before answering, I should clarify the user's request." });
    const demo = request.purpose === 'reasoningTranslation' ? 'Перед ответом следует уточнить запрос пользователя.' : document.documentElement.lang === 'ru' ? 'Это демонстрационный ответ. В приложении здесь будет потоковый ответ модели выбранного сервера.' : 'This is a demonstration response. In the desktop app, the selected server streams its model response here.';
    for (const word of demo.split(' ')) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onDelta({ content: `${word} ` });
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    return;
  }
  if(request.cloud?.provider==='claude')return sendClaudeChat(request.cloud,request.messages,onDelta,signal);
  const requestId = crypto.randomUUID();
  const parser = request.cloud ? responsesStream(onDelta) : chatStream(onDelta);
  let parseError: unknown;
  let complete!: () => void;
  const delivered = new Promise<void>(resolve => { complete = resolve; });
  const cancel = () => { complete(); void invoke(request.cloud?'openai_chat_cancel':'chat_cancel', { requestId }).catch(() => undefined); };
  const channel = new Channel<{ kind: 'ready' | 'chunk' | 'finished'; bytes: number[] }>();
  channel.onmessage = event => {
    if (event.kind === 'ready') { if (signal.aborted) cancel(); return; }
    if (event.kind === 'finished') { complete(); return; }
    if (signal.aborted || parseError) return;
    try { parser.push(new Uint8Array(event.bytes)); }
    catch (error) { parseError = error; cancel(); }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const messages=request.messages.map(({role,content,images,documents})=>({role,content,...(images?.length?{images}:{}),...(documents?.length&&request.cloud?{documents}:{})}));
    await invoke(request.cloud?'openai_chat_send':'chat_send', { requestId, request: request.cloud?{connectionId:request.cloud.connectionId,model:request.cloud.model,messages}:{...request,messages}, onEvent: channel });
    if (parseError) throw parseError;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // Large channel frames can arrive after the invoke result; finish only after ordered delivery.
    await delivered;
    if (parseError) throw parseError;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    parser.finish();
  } catch (error) {
    if (parseError) throw parseError;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw error;
  } finally { signal.removeEventListener('abort', cancel); }
}
