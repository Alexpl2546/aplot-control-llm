// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';

const fixture = vi.hoisted(() => ({
  project: { id: 'project-1', name: 'Stable project', path: 'C:\\projects\\stable', skills: '', createdAt: 1 },
  panelProps: undefined as { projectId: string; disabled: boolean; onAttach?: (attachment: { id: string; name: string; kind: 'file'; text: string }) => void; onBusy?: (busy: boolean) => void } | undefined,
  startGeneration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/store/control', () => ({ useControlStore: create(() => ({
  initialized: true,
  runs: [{ info: { runId: 'server', generation: 1, state: 'ready', engine: 'strata', name: 'Local model', contextTokens: 8192 } }],
  selectedRunId: 'server', selectRun: vi.fn(), notify: vi.fn(),
})) }));
vi.mock('../src/features/openai/store', () => ({
  useOpenAi: create(() => ({
    chatProvider: 'chatgpt', chatModel: 'selected-model', chatProfileId: 'profile-1', claudeChatModel: '',
    status: { connected: true, pending: false, connectionId: 'account-1' },
    models: [{ model: 'selected-model', displayName: 'Selected model' }],
  })),
  cloudSelection: (state: { status: { connectionId?: string; connected?: boolean; pending?: boolean }; models: unknown[] }, _provider: string, connectionId?: string) => ({
    models: !connectionId || connectionId === state.status.connectionId ? state.models : [],
    status: !connectionId || connectionId === state.status.connectionId ? state.status : { connected: false },
  }),
}));
vi.mock('../src/features/agent/workspace', () => ({
  initializeWorkspace: vi.fn().mockResolvedValue(undefined),
  useWorkspaceStore: create(() => ({ ready: true, projects: [fixture.project], tasks: [], memory: [], selectedProjectId: 'project-1', selectedTaskId: '', visibleTaskId: '', error: '', saveError: '' })),
}));
vi.mock('../src/features/chat/generation', () => ({
  startChatGeneration: fixture.startGeneration,
  stopChatGeneration: vi.fn(), translateReasoning: vi.fn(), stopReasoningTranslation: vi.fn(),
}));
vi.mock('../src/components/ui/ActivityOrb', () => ({ ActivityOrb: () => null }));
vi.mock('../src/features/chat/ChatInputExtras', () => ({ ChatInputExtras: () => null }));
vi.mock('../src/features/openai/CloudProfileSelect', () => ({ CloudProfileSelect: () => null }));
vi.mock('../src/features/files/ProjectFilesPanel', () => ({
  ProjectFilesPanel: (props: typeof fixture.panelProps) => {
    if (!props) return null;
    fixture.panelProps = props;
    return <div data-testid="mock-project-files-panel">
      <button type="button" onClick={() => props.onAttach?.({ id: 'managed-1', name: 'findings.txt', kind: 'file', text: 'The deadline is 17 May.' })}>Attach project file</button>
      <button type="button" onClick={() => props.onBusy?.(true)}>Set library busy</button>
      <button type="button" onClick={() => props.onBusy?.(false)}>Clear library busy</button>
    </div>;
  },
}));
vi.mock('../src/features/chat/MessageText', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/features/chat/MessageText')>();
  return { ...actual, MessageText: vi.fn(actual.MessageText) };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ChatView } from '../src/views/ChatView';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import { startChatGeneration } from '../src/features/chat/generation';
import { useOpenAi } from '../src/features/openai/store';
import { useWorkspaceStore } from '../src/features/agent/workspace';
import { useChatPreferences } from '../src/features/chat/preferences';
import { flushChatHistory } from '../src/features/chat/history';

const target = { provider: 'chatgpt' as const, connectionId: 'account-1', profileId: 'profile-1', model: 'selected-model', label: 'Selected model' };
function conversation(id: string, options: { temporary?: boolean } = {}) {
  return { id, title: '', createdAt: 1, updatedAt: 1, target, projectId: 'project-1', ...options };
}

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  vi.clearAllMocks();
  fixture.panelProps = undefined;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  useChatStore.setState({
    threads: { 'chat-1': { ...EMPTY_THREAD } }, conversations: { 'chat-1': conversation('chat-1') },
    selectedId: 'chat-1', historyReady: true, historyError: '',
  });
  useOpenAi.setState({
    chatProvider: 'chatgpt', chatModel: 'selected-model', chatProfileId: 'profile-1', claudeChatModel: '',
    status: { connected: true, pending: false, connectionId: 'account-1' }, models: [{ model: 'selected-model', displayName: 'Selected model' }],
  } as never);
  useWorkspaceStore.setState({ ready: true, projects: [fixture.project], tasks: [], memory: [], selectedProjectId: 'project-1', selectedTaskId: '', visibleTaskId: '', error: '', saveError: '' });
  useChatPreferences.setState({ globalInstructions: '', ready: false, error: false });
  localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(async () => {
  cleanup();
  await flushChatHistory();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function openContextOptions() {
  const summary = document.querySelector('.chatOptions summary');
  if (!summary) throw new Error('Chat context options were not rendered.');
  fireEvent.click(summary);
}

it('adds a project file to the draft, then sends its quoted text to the selected model only on submit', async () => {
  render(<ChatView/>);
  openContextOptions();
  fireEvent.change(screen.getByRole('textbox', { name: 'chat.input' }), { target: { value: 'Summarize the deadline.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Attach project file' }));

  expect(vi.mocked(startChatGeneration)).not.toHaveBeenCalled();
  expect(useChatStore.getState().threads['chat-1']).toMatchObject({
    draft: 'Summarize the deadline.',
    attachments: [{ id: 'managed-1', name: 'findings.txt', kind: 'file', text: 'The deadline is 17 May.' }],
  });

  fireEvent.submit(document.querySelector('form.chatComposer')!);
  await waitFor(() => expect(vi.mocked(startChatGeneration)).toHaveBeenCalledTimes(1));
  const [, request] = vi.mocked(startChatGeneration).mock.calls[0];
  const userMessage = request.messages.at(-1)!;
  expect(request.cloud).toEqual({ provider: 'chatgpt', connectionId: 'account-1', model: 'selected-model' });
  expect(userMessage).toMatchObject({
    role: 'user',
    content: 'Summarize the deadline.\n\nAttached file (quoted data): findings.txt\nThe deadline is 17 May.',
    attachmentText: 'Attached file (quoted data): findings.txt\nThe deadline is 17 May.',
    attachmentNames: ['findings.txt'],
  });
});

it('blocks send button, keyboard and form submission while a project file is loading, then restores sending', async () => {
  render(<ChatView/>);
  openContextOptions();
  const input = screen.getByRole('textbox', { name: 'chat.input' });
  fireEvent.change(input, { target: { value: 'Send when ready.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set library busy' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'chat.send' })).toHaveProperty('disabled', true));
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
  fireEvent.submit(document.querySelector('form.chatComposer')!);
  expect(vi.mocked(startChatGeneration)).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Clear library busy' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'chat.send' })).toHaveProperty('disabled', false));
  fireEvent.submit(document.querySelector('form.chatComposer')!);
  await waitFor(() => expect(vi.mocked(startChatGeneration)).toHaveBeenCalledTimes(1));
});

it('rejects a deferred attachment callback after selection moves to another conversation', async () => {
  useChatStore.setState({
    conversations: { 'chat-1': conversation('chat-1'), 'chat-2': conversation('chat-2') },
    threads: { 'chat-1': { ...EMPTY_THREAD }, 'chat-2': { ...EMPTY_THREAD } }, selectedId: 'chat-1',
    historyReady: true, historyError: '',
  });
  render(<ChatView/>);
  openContextOptions();
  const staleAttach = fixture.panelProps?.onAttach;
  expect(staleAttach).toBeTypeOf('function');
  const deferredAttach = Promise.resolve().then(() => staleAttach?.({ id: 'late', name: 'late.txt', kind: 'file', text: 'late content' }));

  act(() => { useChatStore.getState().select('chat-2'); });
  await expect(deferredAttach).rejects.toThrow('conversation-unavailable');
  expect(useChatStore.getState().selectedId).toBe('chat-2');
  expect(useChatStore.getState().threads['chat-1'].attachments ?? []).toEqual([]);
  expect(useChatStore.getState().threads['chat-2'].attachments ?? []).toEqual([]);
  expect(vi.mocked(startChatGeneration)).not.toHaveBeenCalled();
});

it('does not mount the project file library for a temporary chat', () => {
  fixture.panelProps = undefined;
  useChatStore.setState({
    conversations: { 'temporary-1': conversation('temporary-1', { temporary: true }) },
    threads: { 'temporary-1': { ...EMPTY_THREAD } }, selectedId: 'temporary-1', historyReady: true, historyError: '',
  });
  render(<ChatView/>);
  openContextOptions();

  expect(screen.queryByTestId('mock-project-files-panel')).toBeNull();
  expect(fixture.panelProps).toBeUndefined();
});
