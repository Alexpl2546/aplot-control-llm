// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';
vi.mock('../src/services/tauri', () => ({ isTauri: () => false }));
vi.mock('../src/features/agent/workspace', () => ({ useWorkspaceStore: create(() => ({ ready: true, projects: [] as { id: string; instructions?: string }[], memory: [] as unknown[] })) }));
import { useWorkspaceStore } from '../src/features/agent/workspace';
import { chatInstructions, loadChatPreferences, saveChatPreferences, useChatPreferences } from '../src/features/chat/preferences';

beforeEach(() => {
  localStorage.clear();
  useChatPreferences.setState({ ready: false, error: false, globalInstructions: '' });
  useWorkspaceStore.setState({ ready: true, projects: [], memory: [] });
});

it('persists global instructions and composes only the selected project’s confirmed memory', async () => {
  await loadChatPreferences();
  await saveChatPreferences('Global');
  useWorkspaceStore.setState({ projects: [{ id: 'one', name: 'One', path: 'C:/one', skills: '', createdAt: 0, instructions: 'Project' }], memory: [
    { id: 'confirmed', projectId: 'one', category: 'fact', text: 'Included', confirmed: true, updatedAt: 1 },
    { id: 'draft', projectId: 'one', category: 'fact', text: 'Unconfirmed', confirmed: false, updatedAt: 1 },
    { id: 'other', projectId: 'two', category: 'fact', text: 'Other project', confirmed: true, updatedAt: 1 },
  ] });
  const instructions = chatInstructions({ projectId: 'one', instructions: 'Conversation' });
  expect(instructions.indexOf('Global')).toBeLessThan(instructions.indexOf('Project'));
  expect(instructions.indexOf('Project')).toBeLessThan(instructions.indexOf('Conversation'));
  expect(instructions).toContain('Included');
  expect(instructions).not.toContain('Unconfirmed');
  expect(instructions).not.toContain('Other project');
  expect(chatInstructions({})).toBe('Global');
});

it('blocks unavailable context rather than silently dropping it', async () => {
  expect(() => chatInstructions({})).toThrow('preferences-unavailable');
  await loadChatPreferences();
  expect(() => chatInstructions({ projectId: 'removed' })).toThrow('project-unavailable');
  await expect(saveChatPreferences('x'.repeat(32001))).rejects.toThrow('limit');
});

it('does not overwrite a corrupt preferences store with defaults', async () => {
  localStorage.setItem('aplot.chat.preferences.v1', '{bad');
  await loadChatPreferences();
  expect(useChatPreferences.getState()).toMatchObject({ ready: false, error: true });
  expect(localStorage.getItem('aplot.chat.preferences.v1')).toBe('{bad');
});
