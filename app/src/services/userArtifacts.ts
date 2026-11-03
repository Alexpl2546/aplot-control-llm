import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export interface UserArtifact {
  id: string;
  taskId: string;
  sourceRelative: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  version: number;
  createdAt: string;
}

export async function listUserArtifacts(taskId: string): Promise<UserArtifact[]> {
  if (!isTauri()) return [];
  return invoke<UserArtifact[]>('user_artifact_list', { taskId });
}

export async function saveUserArtifact(taskId: string, sourceRelative: string): Promise<UserArtifact> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke<UserArtifact>('user_artifact_save', { taskId, path: sourceRelative });
}

export async function openUserArtifact(taskId: string, id: string): Promise<void> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke<void>('user_artifact_open', { taskId, id });
}

export async function removeUserArtifact(taskId: string, id: string): Promise<void> {
  if (!isTauri()) throw new Error('desktop-only');
  return invoke<void>('user_artifact_remove', { taskId, id });
}
