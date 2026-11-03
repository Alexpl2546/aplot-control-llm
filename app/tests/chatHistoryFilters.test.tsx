// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const transfer = vi.hoisted(() => ({ exportChatFile: vi.fn(), importChatFile: vi.fn(), tauri: false }));
vi.mock('../src/services/chatTransfer', () => ({ exportChatFile: transfer.exportChatFile, importChatFile: transfer.importChatFile }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => transfer.tauri }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  i18n: { language: 'en' },
}) }));
vi.mock('../src/features/agent/AgentIdentity', () => ({ AgentIcon: () => null }));
vi.mock('../src/store/control', () => ({ useControlStore: { getState: () => ({ notifyAction: vi.fn(), notify: vi.fn() }) } }));

import { ChatHistory } from '../src/features/chat/ChatHistory';
import { EMPTY_THREAD, useChatStore } from '../src/features/chat/store';
import type { ChatConversation, ChatTarget } from '../src/features/chat/historyModel';

const target: ChatTarget = { provider: 'local', runId: 'run', generation: 1, modelId: 'model.gguf', label: 'Local model' };
const recent = Date.now() - 2 * 24 * 60 * 60 * 1000;
const old = Date.now() - 45 * 24 * 60 * 60 * 1000;

function conversation(id: string, title: string, updatedAt: number, projectId?: string, archived = false): ChatConversation {
  return { id, title, createdAt: updatedAt, updatedAt, target, ...(projectId ? { projectId } : {}), ...(archived ? { archivedAt: updatedAt } : {}) };
}

beforeEach(() => {
  transfer.exportChatFile.mockReset();
  transfer.importChatFile.mockReset();
  transfer.tauri = false;
  useChatStore.setState({
    conversations: {
      recent: conversation('recent', 'Recent alpha', recent, 'alpha'),
      old: conversation('old', 'Old beta', old, 'beta'),
      archived: conversation('archived', 'Archived alpha', recent, 'alpha', true),
    },
    threads: {
      recent: { ...EMPTY_THREAD, messages: [{ role: 'user', content: 'recent alpha text' }] },
      old: { ...EMPTY_THREAD, messages: [{ role: 'user', content: 'old beta text' }] },
      archived: { ...EMPTY_THREAD, messages: [{ role: 'user', content: 'archived alpha text' }] },
    },
    selectedId: 'recent', historyReady: true, historyError: '',
  });
});
afterEach(() => cleanup());

describe('chat history filters and temporary creation', () => {
  it('filters by project and date while keeping the archived view separate', () => {
    render(<ChatHistory onSelect={vi.fn()} projects={[{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]} />);
    expect(screen.getByText('Recent alpha')).toBeTruthy();
    expect(screen.getByText('Old beta')).toBeTruthy();
    expect(screen.queryByText('Archived alpha')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'alpha' } });
    expect(screen.getByText('Recent alpha')).toBeTruthy();
    expect(screen.queryByText('Old beta')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Date' }), { target: { value: '7' } });
    expect(screen.getByText('Recent alpha')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Archived conversations' }));
    expect(screen.getByText('Archived alpha')).toBeTruthy();
    expect(screen.queryByText('Recent alpha')).toBeNull();
  });

  it('creates a new target-matched temporary chat instead of reopening a saved conversation', () => {
    const onSelect = vi.fn();
    render(<ChatHistory onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'New temporary chat' }));

    const selectedId = useChatStore.getState().selectedId;
    const created = useChatStore.getState().conversations[selectedId];
    expect(created).toMatchObject({ temporary: true, target });
    expect(created).not.toHaveProperty('projectId');
    expect(created).not.toHaveProperty('instructions');
    expect(created).not.toHaveProperty('webSearch');
    expect(selectedId).not.toBe('recent');
    expect(onSelect).toHaveBeenCalledWith(selectedId);
  });

  it('uses the native file picker and excludes temporary content from export', async () => {
    transfer.tauri = true;
    useChatStore.setState(state => ({
      conversations: { ...state.conversations, transient: { ...conversation('transient', 'Private temp', recent), temporary: true } },
      threads: { ...state.threads, transient: { ...EMPTY_THREAD, messages: [{ role: 'user', content: 'never export this' }] } },
      selectedId: 'transient',
    }));
    render(<ChatHistory onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(transfer.exportChatFile).toHaveBeenCalledTimes(1));
    const [format, contents] = transfer.exportChatFile.mock.calls[0]!;
    expect(format).toBe('json');
    expect(contents).not.toContain('transient');
    expect(contents).not.toContain('never export this');
    expect(JSON.parse(contents).selectedId).not.toBe('transient');

    transfer.importChatFile.mockResolvedValue(JSON.stringify({ version: 1, selectedId: '', conversations: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Import history' }));
    await waitFor(() => expect(transfer.importChatFile).toHaveBeenCalledTimes(1));
  });
});
