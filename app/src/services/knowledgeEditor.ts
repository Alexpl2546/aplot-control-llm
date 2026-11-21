import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export interface KnowledgeEditorDocument {
  vaultId: string;
  path: string;
  /** Markdown body with LF newlines; the stored frontmatter is not exposed for editing. */
  content: string;
  /** SHA-256 of the full on-disk note, used to detect edits made outside Aplot. */
  etag: string;
  lineEnding: 'lf' | 'crlf' | 'cr';
}

const desktop = () => { if (!isTauri()) throw new Error('desktop-only'); };

export async function knowledgeEditorRead(vaultId: string, path: string): Promise<KnowledgeEditorDocument> {
  desktop();
  return invoke<KnowledgeEditorDocument>('knowledge_editor_read', { vaultId, path });
}

export async function knowledgeEditorSave(
  vaultId: string,
  path: string,
  content: string,
  expectedEtag: string,
): Promise<KnowledgeEditorDocument> {
  desktop();
  return invoke<KnowledgeEditorDocument>('knowledge_editor_save', { vaultId, path, content, expectedEtag });
}
