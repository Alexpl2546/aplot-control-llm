// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('../src/store/control', () => ({ useControlStore: create(() => ({
  runs: [{ info: { runId: 'server', generation: 1, state: 'ready', engine: 'strata', name: 'Local model', contextTokens: 8192 } }],
  selectedRunId: 'server', selectRun: vi.fn(), notify: vi.fn(),
})) }));
vi.mock('../src/features/openai/store', () => ({
  useOpenAi: create(() => ({ chatProvider: 'local', chatModel: '', chatProfileId: '', status: { connected: false }, models: [] })),
  cloudSelection: (state: { status: { connectionId?: string }; models: unknown[] }, _provider: string, connectionId?: string) => ({ models: !connectionId || connectionId === state.status.connectionId ? state.models : [], status: !connectionId || connectionId === state.status.connectionId ? state.status : { connected: false } }),
}));
vi.mock('../src/features/chat/generation', () => ({
  startChatGeneration: vi.fn().mockResolvedValue(undefined), stopChatGeneration: vi.fn(),
  translateReasoning: vi.fn(), stopReasoningTranslation: vi.fn(),
}));
vi.mock('../src/components/ui/ActivityOrb', () => ({ ActivityOrb: () => null }));
vi.mock('../src/features/chat/ChatInputExtras', () => ({ ChatInputExtras: () => null }));
vi.mock('../src/features/openai/CloudProfileSelect', () => ({ CloudProfileSelect: () => null }));
vi.mock('../src/features/chat/MessageText', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/features/chat/MessageText')>();
  return { ...actual, MessageText: vi.fn(actual.MessageText) };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ChatView } from '../src/views/ChatView';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import { startChatGeneration } from '../src/features/chat/generation';
import { useControlStore } from '../src/store/control';
import { MessageText } from '../src/features/chat/MessageText';
import { useOpenAi } from '../src/features/openai/store';
import { flushChatHistory } from '../src/features/chat/history';

const conversation = { id: 'server:1', title: '', createdAt: 1, updatedAt: 1, target: { provider: 'local' as const, runId: 'server', generation: 1, label: 'Local model' } };

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  useChatStore.setState({ threads: {}, conversations: { 'server:1': conversation }, selectedId: 'server:1', historyReady: true, historyError: '' });
  useOpenAi.setState({ chatProvider: 'local', chatModel: '', chatProfileId: '', status: { connected: false, pending: false } });
  localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(async () => {
  cleanup();
  await flushChatHistory();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

it.each([
  { images: ['data:image/png;base64,AA=='] },
  { documents: [{ name: 'report.pdf', data: 'data:application/pdf;base64,AA==' }] },
])('keeps attachment-only questions in the next request history: %j', async attachment => {
  const question = { role: 'user' as const, content: '', ...attachment };
  useChatStore.setState({ threads: { 'server:1': { ...EMPTY_THREAD, draft: 'Explain that again', messages: [question, { role: 'assistant', content: 'Description' }, { role: 'assistant', content: '' }] } } });
  render(<ChatView/>);
  fireEvent.submit(document.querySelector('form')!);
  await waitFor(() => expect(startChatGeneration).toHaveBeenCalledTimes(1));
  expect(vi.mocked(startChatGeneration).mock.calls[0][1].messages).toEqual([
    question, { role: 'assistant', content: 'Description' }, expect.objectContaining({ role: 'user', content: 'Explain that again' }),
  ]);
});

it('creates a fresh conversation without losing the previous draft or attachments', () => {
  useChatStore.setState({ threads: { 'server:1': { ...EMPTY_THREAD, draft: 'Unsent', attachments: [{ id: 'image', name: 'photo.png', kind: 'image', data: 'data:image/png;base64,AA==' }] } } });
  render(<ChatView/>);
  const button = screen.getByRole('button', { name: 'chat.new' });
  expect(button.hasAttribute('disabled')).toBe(false);
  fireEvent.click(button);
  const state = useChatStore.getState();
  expect(state.selectedId).not.toBe('server:1');
  expect(state.threads[state.selectedId]).toMatchObject({ messages: [], draft: '' });
  expect(state.threads['server:1']).toMatchObject({ draft: 'Unsent', attachments: [{ id: 'image', name: 'photo.png' }] });
  // The new conversation is still blank, so history lists only the one with the draft.
  expect(document.querySelectorAll('.chatHistorySelect')).toHaveLength(1);
  fireEvent.click(document.querySelectorAll<HTMLButtonElement>('.chatHistorySelect')[0]);
  expect(screen.getByRole('textbox', { name: 'chat.input' })).toHaveProperty('value', 'Unsent');
});

it('does not rerender existing Markdown while typing a draft', () => {
  useChatStore.setState({ threads: { 'server:1': { ...EMPTY_THREAD, messages: [{ role: 'assistant', content: '**Long formatted answer**' }] } } });
  render(<ChatView/>);
  const count = vi.mocked(MessageText).mock.calls.length;
  fireEvent.change(screen.getByRole('textbox', { name: 'chat.input' }), { target: { value: 'Next question' } });
  expect(vi.mocked(MessageText).mock.calls.length).toBe(count);
});

it('keeps a restored conversation read-only when a restarted server reuses its generation number', () => {
  useChatStore.setState({ conversations: { 'server:1': { ...conversation, target: { ...conversation.target, startedAt: 'previous-launch' } } }, threads: { 'server:1': { ...EMPTY_THREAD, draft: 'Do not redirect', messages: [{ role: 'assistant', content: 'Saved answer' }] } } });
  render(<ChatView/>);
  expect(screen.getByRole('textbox', { name: 'chat.input' })).toHaveProperty('disabled', true);
  expect(screen.getByText('chat.targetUnavailable')).toBeTruthy();
  fireEvent.submit(document.querySelector('form.chatComposer')!);
  expect(startChatGeneration).not.toHaveBeenCalled();
});

it('explicitly continues unavailable history in a new target without losing its context or the original', () => {
  const messages = [{ role: 'user' as const, content: 'Saved question' }, { role: 'assistant' as const, content: 'Saved answer' }];
  useChatStore.setState({ conversations: { 'server:1': { ...conversation, title: 'Saved conversation', target: { ...conversation.target, startedAt: 'previous-launch' } } }, threads: { 'server:1': { ...EMPTY_THREAD, draft: 'Follow-up', messages } } });
  render(<ChatView/>);
  fireEvent.click(screen.getByRole('button', { name: 'chat.continueNew' }));
  const state = useChatStore.getState();
  expect(state.selectedId).not.toBe('server:1');
  expect(state.threads[state.selectedId]).toMatchObject({ draft: 'Follow-up', messages });
  expect(state.threads[state.selectedId].messages).not.toBe(messages);
  expect(state.threads['server:1'].messages).toBe(messages);
  expect(screen.getByRole('textbox', { name: 'chat.input' })).toHaveProperty('disabled', false);
});

it('waits for runtime initialization before binding the first conversation', () => {
  useControlStore.setState({ initialized: false });
  useChatStore.setState({ conversations: {}, threads: {}, selectedId: '' });
  const { rerender } = render(<ChatView/>);
  expect(useChatStore.getState().selectedId).toBe('');
  useControlStore.setState({ initialized: true });
  rerender(<ChatView/>);
  const state = useChatStore.getState();
  expect(state.conversations[state.selectedId].target).toMatchObject({ provider: 'local', runId: 'server', generation: 1 });
});

it('does not send saved ChatGPT history to a different connection after restoring it', () => {
  useOpenAi.setState({ status: { connected: true, pending: false, connectionId: 'new-account' }, models: [{ model: 'same-model', displayName: 'Same model' }] } as never);
  useChatStore.setState({ conversations: { saved: { ...conversation, id: 'saved', target: { provider: 'chatgpt', connectionId: 'old-account', model: 'same-model', label: 'ChatGPT' } } }, selectedId: 'saved', threads: { saved: { ...EMPTY_THREAD, draft: 'Private context', messages: [{ role: 'assistant', content: 'Saved cloud answer' }] } } });
  render(<ChatView/>);
  expect(screen.getByRole('textbox', { name: 'chat.input' })).toHaveProperty('disabled', true);
  fireEvent.submit(document.querySelector('form.chatComposer')!);
  expect(startChatGeneration).not.toHaveBeenCalled();
});

it('searches, renames and selects a saved conversation', () => {
  useChatStore.setState({ threads: { 'server:1': { ...EMPTY_THREAD, messages: [{ role: 'user', content: 'Unique search words' }] } } });
  render(<ChatView/>);
  fireEvent.change(screen.getByRole('searchbox', { name: 'chat.historySearch' }), { target: { value: 'missing' } });
  expect(screen.getByText('chat.historyNoResults')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'chat.historySearch' }), { target: { value: 'unique' } });
  fireEvent.click(screen.getByRole('button', { name: 'chat.rename: chat.untitled' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'chat.renameTitle' }), { target: { value: 'Renamed chat' } });
  fireEvent.submit(document.querySelector('form.chatHistoryRename')!);
  expect(useChatStore.getState().conversations['server:1'].title).toBe('Renamed chat');
});

it('reports copy failure when the host has no clipboard API', async () => {
  useChatStore.setState({ threads: { 'server:1': { ...EMPTY_THREAD, messages: [{ role: 'assistant', content: 'Answer' }] } } });
  render(<ChatView/>);
  fireEvent.click(screen.getByRole('button', { name: 'chat.copy' }));
  await waitFor(() => expect(useControlStore.getState().notify).toHaveBeenCalledWith('error', 'chat.copyFailed'));
});

it('handles failed code copying and resets feedback when streamed code changes', async () => {
  const { rerender } = render(<MessageText text={'```js\nconst first = 1;\n```'}/>);
  fireEvent.click(screen.getByRole('button', { name: 'chat.copy' }));
  await screen.findByRole('button', { name: 'chat.copyFailed' });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole('button', { name: 'chat.copyFailed' }));
  await screen.findByRole('button', { name: 'chat.copied' });
  expect(writeText).toHaveBeenCalledWith('const first = 1;\n');
  rerender(<MessageText text={'```js\nconst second = 2;\n```'}/>);
  expect(screen.getByRole('button', { name: 'chat.copy' })).toBeTruthy();
});
