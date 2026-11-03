import { invoke } from '@tauri-apps/api/core';
import type { ChatAttachment } from '../features/chat/media';
import { isTauri } from './tauri';

export interface ProjectFile {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  version: number;
  createdAt: string;
  indexed: boolean;
  truncated: boolean;
}

export interface ProjectFileContent {
  name: string;
  mime: string;
  data?: string;
  text?: string;
}

export interface ProjectFileMatch {
  file: ProjectFile;
  snippet: string;
}

function requireDesktop(): void {
  if (!isTauri()) throw new Error('Project files are only available in the desktop application.');
}

/** Import a managed copy into the selected project; the source path is never retained by the UI. */
export async function importProjectFile(projectId: string, path: string): Promise<ProjectFile> {
  requireDesktop();
  return invoke<ProjectFile>('project_files_import', { projectId, path });
}

/** Browser previews intentionally show no project files. */
export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  if (!isTauri()) return [];
  return invoke<ProjectFile[]>('project_files_list', { projectId });
}

export async function readProjectFile(projectId: string, id: string): Promise<ProjectFileContent> {
  requireDesktop();
  return invoke<ProjectFileContent>('project_files_read', { projectId, id });
}

export async function removeProjectFile(projectId: string, id: string): Promise<void> {
  requireDesktop();
  await invoke<void>('project_files_remove', { projectId, id });
}

/** Export the verified managed binary to a user-selected destination. */
export async function exportProjectFile(projectId: string, id: string, path: string): Promise<void> {
  requireDesktop();
  await invoke<void>('project_files_export', { projectId, id, path });
}

/** Search is project-scoped and returns bounded plain-text snippets from the native index. */
export async function searchProjectFiles(projectId: string, query: string): Promise<ProjectFileMatch[]> {
  if (!isTauri()) return [];
  return invoke<ProjectFileMatch[]>('project_files_search', { projectId, query });
}

/** Create a transient chat attachment from a managed project copy. It deliberately has no filesystem path. */
export async function readProjectFileAttachment(projectId: string, id: string): Promise<ChatAttachment> {
  const file = await readProjectFile(projectId, id);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    kind: file.mime.startsWith('image/') ? 'image' : 'file',
    ...(file.data === undefined ? {} : { data: file.data }),
    ...(file.text === undefined ? {} : { text: file.text }),
  };
}
