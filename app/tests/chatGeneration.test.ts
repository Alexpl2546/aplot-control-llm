import { beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { ChatDelta } from '../src/features/chat/stream';

vi.mock('../src/store/control', () => ({ useControlStore: create(() => ({ runs: [{ info: { runId: 'server', generation: 1, state: 'ready' } }], view: 'chat', selectedRunId: 'server' })) }));
vi.mock('../src/services/chat', () => ({ sendChat: vi.fn() }));
import { useControlStore } from '../src/store/control';
import { sendChat } from '../src/services/chat';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import { startChatGeneration, stopChatGeneration, translateReasoning, stopReasoningTranslation } from '../src/features/chat/generation';

const key = 'server:1';
const request = { runId: 'server', generation: 1, messages: [{ role: 'user' as const, content: 'Hi' }], temperature: .2, maxTokens: 100 };
let emit: (delta: ChatDelta) => void, signal: AbortSignal, finish: () => void;
beforeEach(() => {
  useChatStore.setState({ threads: { [key]: { ...EMPTY_THREAD, messages: [...request.messages, { role: 'assistant', content: '' }] } } });
  useControlStore.setState({ runs: [{ info: { runId: 'server', generation: 1, state: 'ready' } }] } as never);
  vi.mocked(sendChat).mockReset().mockImplementation((_request, callback, abort) => {
    emit = callback; signal = abort;
    return new Promise<void>((resolve, reject) => { finish = resolve; abort.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }); });
  });
});
it('keeps streaming and pending state through navigation and server selection changes', async () => {
  const done = startChatGeneration(key, request);
  emit({ content: 'First' });
  useControlStore.setState({ view: 'dashboard', selectedRunId: 'another' });
  expect(signal.aborted).toBe(false);
  emit({ content: ' second', reasoning: 'Пояснение' });
  useControlStore.setState({ view: 'chat', selectedRunId: 'server' });
  expect(useChatStore.getState().threads[key].pending).toBe(true);
  await startChatGeneration(key, request);
  expect(sendChat).toHaveBeenCalledTimes(1);
  finish(); await done;
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, stopped: false, messages: [request.messages[0], { role: 'assistant', content: 'First second', reasoning: 'Пояснение' }] });
});
it('allows stopping after navigating away and retains the partial reply', async () => {
  const done = startChatGeneration(key, request);
  emit({ content: 'Partial' });
  stopChatGeneration(key);
  emit({ content: 'ignored' });
  await done;
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, stopped: true });
  expect(useChatStore.getState().threads[key].messages.at(-1)?.content).toBe('Partial');
});
it.each(['stopped', 'restarted', 'removed'])('cancels in the background when the server is %s', async change => {
  const done = startChatGeneration(key, request);
  useControlStore.setState({ runs: change === 'removed' ? [] : [{ info: { runId: 'server', generation: change === 'restarted' ? 2 : 1, state: change === 'stopped' ? 'stopped' : 'ready' } }] } as never);
  expect(signal.aborted).toBe(true);
  await done;
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, stopped: true });
});

it.each(['strata', 'llama_cpp', 'legacy', 'future_engine'])('translates foreign reasoning independently of the %s engine/profile', async engine => {
  useControlStore.setState({ runs: [{ info: { runId: 'server', generation: 1, state: 'ready', engine, contextTokens: 8192 } }] } as never);
  vi.mocked(sendChat).mockImplementation(async (input, delta) => {
    if (!input.purpose) { delta({ content: 'Готовый ответ', reasoning: 'The user wants an app. First consider the design.' }); return; }
    expect(input.messages).toEqual([{ role: 'user', content: 'The user wants an app. First consider the design.' }]);
    expect(input.temperature).toBe(0);
    useControlStore.setState({ view: 'dashboard' });
    expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, translating: true });
    delta({ reasoning: 'Ignored auxiliary analysis', content: 'Пользователь хочет приложение. Сначала рассмотрим оформление.' });
  });
  await startChatGeneration(key, request);
  expect(sendChat).toHaveBeenCalledTimes(1);
  await translateReasoning(key, 1, request);
  const reply = useChatStore.getState().threads[key].messages.at(-1);
  expect(reply).toMatchObject({ content: 'Готовый ответ', reasoning: 'The user wants an app. First consider the design.', reasoningRu: 'Пользователь хочет приложение. Сначала рассмотрим оформление.', reasoningTranslation: 'done' });
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, translating: false, error: '' });
});
it.each(['wrongLanguage', 'network', 'truncated'])('preserves the final answer and original when translation fails: %s', async failure => {
  vi.mocked(sendChat).mockImplementation(async (input, delta) => {
    if (!input.purpose) { delta({ content: 'Ответ', reasoning: 'First consider the design.' }); return; }
    if (failure === 'network') throw new Error('network');
    delta({ content: failure === 'wrongLanguage' ? 'First consider the design.' : 'Сначала рассмотрим оформление.', finishReason: failure === 'truncated' ? 'length' : 'stop' });
  });
  await startChatGeneration(key, request);
  await translateReasoning(key, 1, request);
  expect(useChatStore.getState().threads[key].messages.at(-1)).toMatchObject({ content: 'Ответ', reasoning: 'First consider the design.', reasoningTranslation: 'failed' });
  expect(useChatStore.getState().threads[key].error).toBe('');
});
it('stops auxiliary translation without discarding the completed answer', async () => {
  vi.mocked(sendChat).mockImplementation(async (input, delta) => {
    if (!input.purpose) { delta({ content: 'Ответ', reasoning: 'First consider the design.' }); return; }
    stopReasoningTranslation(key);
    throw new Error('Aborted');
  });
  await startChatGeneration(key, request);
  await translateReasoning(key, 1, request);
  expect(useChatStore.getState().threads[key]).toMatchObject({ stopped: false, pending: false, error: '' });
  expect(useChatStore.getState().threads[key].messages.at(-1)).toMatchObject({ content: 'Ответ', reasoningTranslation: 'stopped' });
});

it.each(['strata', 'llama_cpp', 'legacy', 'future_engine'])('never automatically translates reasoning for %s', async engine => {
  useControlStore.setState({ runs: [{ info: { runId: 'server', generation: 1, state: 'ready', engine } }] } as never);
  vi.mocked(sendChat).mockImplementation(async (_input, delta) => { delta({ content: 'Ответ', reasoning: 'English analysis remains original.' }); });
  await startChatGeneration(key, request);
  expect(sendChat).toHaveBeenCalledTimes(1);
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, translating: false });
  expect(useChatStore.getState().threads[key].messages.at(-1)).toMatchObject({ reasoning: 'English analysis remains original.' });
  expect(useChatStore.getState().threads[key].messages.at(-1)?.reasoningTranslation).toBeUndefined();
});
it('prioritizes a new question over translation and ignores late translation results', async () => {
  useChatStore.getState().update(key, s => ({ ...s, messages: [{ role: 'assistant', content: 'Ответ', reasoning: 'English analysis' }] }));
  let finishTranslation!: () => void;
  let translationSignal!: AbortSignal;
  vi.mocked(sendChat).mockImplementation(async (input, delta, abort) => {
    if (input.purpose) {
      translationSignal = abort;
      await new Promise<void>(resolve => { finishTranslation = resolve; });
      delta({ content: 'Поздний перевод' });
    } else { delta({ content: 'Новый ответ' }); }
  });
  const translation = translateReasoning(key, 0, request);
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, translating: true });
  useChatStore.getState().update(key, s => ({ ...s, messages: [...s.messages, { role: 'user', content: 'Следующий вопрос' }, { role: 'assistant', content: '' }] }));
  await startChatGeneration(key, request);
  expect(translationSignal.aborted).toBe(true);
  expect(useChatStore.getState().threads[key].messages[2].content).toBe('Новый ответ');
  finishTranslation(); await translation;
  expect(useChatStore.getState().threads[key].messages[0]).toMatchObject({ reasoningTranslation: 'stopped' });
  expect(useChatStore.getState().threads[key].messages[0].reasoningRu).toBeUndefined();
  expect(useChatStore.getState().threads[key]).toMatchObject({ pending: false, translating: false });
});
