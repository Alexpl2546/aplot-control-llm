import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export interface KnowledgeVault { id: string; name: string; path: string; exclusions: string[]; addedAt: string; }
export interface KnowledgeReport { indexed: number; removed: number; unchanged: number; skipped: number; failed: number; truncated: boolean; }
export interface KnowledgeVaultStatus {
  vault: KnowledgeVault;
  documents: number;
  chunks: number;
  /** The folder has `.obsidian`, so `obsidian://` links will open in that vault. */
  obsidian: boolean;
  state: 'indexing' | 'ready' | 'missing' | 'error';
  error?: string | null;
  report?: KnowledgeReport | null;
  indexedAt?: string | null;
  watching: boolean;
}
export interface KnowledgeStatus { available: boolean; error?: string | null; vaults: KnowledgeVaultStatus[]; }
export interface KnowledgeHit { vaultId: string; path: string; title: string; heading: string; line: number; snippet: string; matched: 'exact' | 'prefix' | 'partial'; tags: string[]; }
export interface KnowledgeLinkedNote { vaultId: string; path: string; title: string; }
export interface KnowledgeNote {
  vaultId: string; vaultName: string; path: string; absolutePath: string; obsidianUri: string;
  title: string; properties: Record<string, unknown>; tags: string[]; aliases: string[];
  body: string; bodyLine: number;
  outline: { heading: string; level: number; line: number }[];
  links: { target: string; kind: string; line: number }[];
  backlinks: KnowledgeLinkedNote[];
  size: number; modified: number;
}

const desktop = () => { if (!isTauri()) throw new Error('desktop-only'); };

export async function knowledgeStatus(): Promise<KnowledgeStatus> {
  if (!isTauri()) return { available: false, error: 'desktop-only', vaults: [] };
  return invoke('knowledge_status');
}
export async function knowledgeBind(path: string, exclusions?: string[]): Promise<KnowledgeVault> {
  desktop();
  return invoke('knowledge_bind', { path, exclusions });
}
export async function knowledgeUnbind(vaultId: string): Promise<void> {
  desktop();
  return invoke('knowledge_unbind', { vaultId });
}
export async function knowledgeReindex(vaultId: string): Promise<void> {
  desktop();
  return invoke('knowledge_reindex', { vaultId });
}
export async function knowledgeSearch(query: string, vaultIds?: string[], limit = 30): Promise<KnowledgeHit[]> {
  if (!isTauri()) return [];
  return invoke('knowledge_search', { query, vaultIds, limit });
}
export async function knowledgeRead(vaultId: string, path: string): Promise<KnowledgeNote> {
  desktop();
  return invoke('knowledge_read', { vaultId, path });
}
export async function knowledgeOpenObsidian(vaultId: string, path: string): Promise<void> {
  desktop();
  return invoke('knowledge_open_obsidian', { vaultId, path });
}
