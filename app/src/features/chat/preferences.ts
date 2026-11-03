import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { isTauri } from '../../services/tauri';
import { useWorkspaceStore } from '../agent/workspace';
import { memoryContext, confirmedMemorySnapshot } from '../agent/workspaceModel';

interface ChatPreferences { globalInstructions: string; }
export const useChatPreferences = create<ChatPreferences & { ready: boolean; error: boolean }>(() => ({ globalInstructions: '', ready: false, error: false }));
let loading: Promise<void> | undefined;
let saving = Promise.resolve();
const storageKey = 'aplot.chat.preferences.v1';
export function loadChatPreferences() {
  if (useChatPreferences.getState().ready) return Promise.resolve();
  return loading ??= (async () => {
    try {
      const raw: unknown = isTauri() ? await invoke('chat_preferences_load') : JSON.parse(localStorage.getItem(storageKey) ?? '{"globalInstructions":""}');
      if (!raw || typeof raw !== 'object' || !('globalInstructions' in raw) || typeof raw.globalInstructions !== 'string' || new TextEncoder().encode(raw.globalInstructions).length > 32000) throw new Error('invalid');
      useChatPreferences.setState({ globalInstructions: raw.globalInstructions, ready: true, error: false });
    } catch { useChatPreferences.setState({ error: true }); }
  })().finally(() => { loading = undefined; });
}
export async function saveChatPreferences(globalInstructions: string) {
  if (new TextEncoder().encode(globalInstructions).length > 32000) throw new Error('limit');
  const preferences = { globalInstructions };
  const operation = saving.catch(() => undefined).then(async () => {
    if (isTauri()) await invoke('chat_preferences_save', { preferences });
    else localStorage.setItem(storageKey, JSON.stringify(preferences));
    useChatPreferences.setState({ ...preferences, ready: true, error: false });
  });
  saving = operation;
  await operation;
}
/** Confirmed project memory is reference material, not tool authorization. */
export function chatInstructions(conversation: { projectId?: string; instructions?: string; temporary?: boolean }) {
  const preferences = useChatPreferences.getState();
  if (!preferences.ready) throw new Error('preferences-unavailable');
  if (conversation.temporary) return [preferences.globalInstructions, conversation.instructions].filter(value => value?.trim()).join('\n\n');
  const workspace = useWorkspaceStore.getState();
  if (conversation.projectId && (!workspace.ready || !workspace.projects.some(project => project.id === conversation.projectId))) throw new Error('project-unavailable');
  const project = workspace.projects.find(project => project.id === conversation.projectId);
  const memory = project ? memoryContext(confirmedMemorySnapshot(workspace.memory.filter(item => item.projectId === project.id))) : '';
  return [preferences.globalInstructions, project?.instructions, conversation.instructions, memory].filter(value => value?.trim()).join('\n\n');
}
