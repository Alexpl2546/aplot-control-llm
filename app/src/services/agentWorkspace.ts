import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import type { WorkspaceEnvelope } from './client/agentTaskClient';
import type { WorkspaceFile, WorkspaceSkill } from '../features/agent/workspaceModel';

export type { WorkspaceEnvelope } from './client/agentTaskClient';
const PREVIEW_KEY = 'aplot-agent-workspace-v2-preview';
export async function loadWorkspace(): Promise<WorkspaceEnvelope | null> {
  if (isTauri()) return invoke('agent_workspace_load');
  const value = localStorage.getItem(PREVIEW_KEY);
  return value ? JSON.parse(value) as WorkspaceEnvelope : null;
}
export async function saveWorkspace(data: Record<string, unknown>, revision: number): Promise<number> {
  if (isTauri()) return invoke('agent_workspace_save', { data, revision });
  const current = localStorage.getItem(PREVIEW_KEY);
  if (current && (JSON.parse(current) as WorkspaceEnvelope).revision !== revision) throw new Error('workspace-conflict');
  localStorage.setItem(PREVIEW_KEY, JSON.stringify({ version: 2, revision: revision + 1, data }));
  return revision + 1;
}
/** Read the persisted envelope without legacy import or relocation side effects. */
export async function syncWorkspaceSnapshot(): Promise<WorkspaceEnvelope | null> {
  if (isTauri()) return invoke('agent_workspace_sync_snapshot');
  return loadWorkspace();
}
export async function validateWorkspaceFolder(path: string): Promise<string> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke('agent_workspace_folder', { path });
}
export async function workspaceFiles(projectId: string, path = ''): Promise<WorkspaceFile[]> {
  if (!isTauri()) return [];
  return invoke('agent_workspace_files', { projectId, path });
}
export async function workspaceRead(projectId: string, path: string): Promise<string> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke('agent_workspace_read', { projectId, path });
}
export async function workspaceOpen(projectId: string, path: string): Promise<void> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke('agent_workspace_open', { projectId, path });
}
export async function workspaceOpenDocument(projectId: string, path: string): Promise<void> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke('agent_workspace_open_document', { projectId, path });
}
export async function workspaceSkills(path: string): Promise<WorkspaceSkill[]> {
  if (!isTauri() || !path) return [];
  return invoke('agent_workspace_skills', { path });
}
