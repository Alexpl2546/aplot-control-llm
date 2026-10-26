import { useControlStore } from '../../store/control';
import { sendChat, type ChatRequest } from '../../services/chat';
import { useChatStore } from './store';
import { isRussianReasoning, reasoningChunks } from './reasoningLanguage';
import type { ChatMessage } from './stream';

// Requests belong to server generations, independently of mounted views or selection.
const active = new Map<string, AbortController>();
export function stopChatGeneration(key: string) { active.get(key)?.abort(); }

export async function startChatGeneration(key: string, request: ChatRequest) {
  if (active.has(key)) return;
  stopReasoningTranslation(key);
  const abort = new AbortController();
  active.set(key, abort);
  const update = (edit: Parameters<ReturnType<typeof useChatStore.getState>['update']>[1]) => useChatStore.getState().update(key, edit);
  update(s => ({ ...s, pending: true, translating: false, error: '', stopped: false }));
  const checkServer = (state: ReturnType<typeof useControlStore.getState>) => {
    if(request.cloud)return;
    const run = state.runs.find(r => r.info.runId === request.runId);
    if (!run || run.info.generation !== request.generation || !['ready', 'busy'].includes(run.info.state)) abort.abort();
  };
  const unsubscribe = useControlStore.subscribe(checkServer);
  checkServer(useControlStore.getState());
  try {
    await sendChat(request, delta => {
      if (abort.signal.aborted) return;
      update(s => {
        const messages = [...s.messages], last = messages[messages.length - 1];
        if (!last || last.role !== 'assistant') return s;
        messages[messages.length - 1] = { ...last, content: last.content + (delta.content ?? ''), reasoning: (last.reasoning ?? '') + (delta.reasoning ?? '') };
        return { ...s, messages };
      });
    }, abort.signal);
    if (abort.signal.aborted) update(s => ({ ...s, stopped: true }));

  } catch (error) {
    if (abort.signal.aborted) update(s => ({ ...s, stopped: true }));
    else {
      const code = String(error).replace(/^Error: /, '');
      update(s => ({ ...s, error: ['incomplete', 'streamError', 'unavailable', 'changed', 'limit', 'auth', 'unsupported', 'network','quota'].includes(code) ? code : 'failed' }));
    }
  } finally {
    unsubscribe();
    active.delete(key);
    update(s => ({ ...s, pending: false, translating: false }));
  }
}

// Auxiliary work never occupies the answer slot. Sending a question cancels it immediately.
interface TranslationJob { abort: AbortController; index: number; source: string; }
const translations = new Map<string, TranslationJob>();

export function stopReasoningTranslation(key: string) {
  const job = translations.get(key);
  if (!job) return;
  job.abort.abort();
  translations.delete(key);
  useChatStore.getState().update(key, s => ({ ...s, translating: false, messages: s.messages.map((m, i) => i === job.index && m.reasoning === job.source && m.reasoningTranslation === 'pending' ? { ...m, reasoningTranslation: 'stopped' } : m) }));
}

export async function translateReasoning(key: string, index: number, target: Pick<ChatRequest, 'runId' | 'generation'>) {
  if (active.has(key) || translations.has(key)) return;
  const source = useChatStore.getState().threads[key]?.messages[index]?.reasoning;
  if (!source?.trim()) return;
  const job: TranslationJob = { abort: new AbortController(), index, source };
  translations.set(key, job);
  const edit = (patch: Partial<ChatMessage>) => {
    if (translations.get(key) !== job) return;
    useChatStore.getState().update(key, s => ({ ...s, messages: s.messages.map((m, i) => i === index && m.reasoning === source ? { ...m, ...patch } : m) }));
  };
  useChatStore.getState().update(key, s => ({ ...s, translating: true }));
  edit({ reasoningTranslation: 'pending' });
  const checkServer = (state: ReturnType<typeof useControlStore.getState>) => {
    const run = state.runs.find(r => r.info.runId === target.runId);
    if (!run || run.info.generation !== target.generation || !['ready', 'busy'].includes(run.info.state)) stopReasoningTranslation(key);
  };
  const unsubscribe = useControlStore.subscribe(checkServer);
  checkServer(useControlStore.getState());
  try {
    const context = useControlStore.getState().runs.find(r => r.info.runId === target.runId)?.info.contextTokens || 8192;
    const limit = Math.min(2400, Math.max(256, Math.floor(context / 4)));
    const translated: string[] = [];
    for (const chunk of reasoningChunks(source, limit)) {
      if (job.abort.signal.aborted) throw new Error('cancelled');
      if (isRussianReasoning(chunk)) { translated.push(chunk); continue; }
      let result = '', truncated = false;
      await sendChat({ ...target, purpose: 'reasoningTranslation', messages: [{ role: 'user', content: chunk }], temperature: 0, maxTokens: Math.min(4096, Math.max(256, Math.floor(context / 2))) }, delta => {
        if (!job.abort.signal.aborted) { result += delta.content ?? ''; truncated ||= delta.finishReason === 'length'; }
      }, job.abort.signal);
      if (truncated || !result.trim() || !isRussianReasoning(result)) throw new Error('translationFailed');
      translated.push(result.trim());
    }
    if (job.abort.signal.aborted) throw new Error('cancelled');
    edit({ reasoningRu: translated.join('\n\n'), reasoningTranslation: 'done' });
  } catch {
    edit({ reasoningTranslation: job.abort.signal.aborted ? 'stopped' : 'failed' });
  } finally {
    unsubscribe();
    if (translations.get(key) === job) {
      translations.delete(key);
      useChatStore.getState().update(key, s => ({ ...s, translating: false }));
    }
  }
}
