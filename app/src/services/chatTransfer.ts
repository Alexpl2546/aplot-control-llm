import { invoke } from '@tauri-apps/api/core';
import { open, save } from './filePicker';
import { isTauri } from './tauri';

export async function exportChatFile(format: 'json' | 'markdown', contents: string): Promise<void> {
  const extension = format === 'json' ? 'json' : 'md';
  if (isTauri()) {
    const path = await save({ defaultPath: `aplot-chat-history.${extension}`, filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [extension] }] });
    if (path) await invoke('chat_export_file', { path, format, contents });
    return;
  }
  const url = URL.createObjectURL(new Blob([contents], { type: format === 'json' ? 'application/json' : 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url; link.download = `aplot-chat-history.${extension}`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export async function importChatFile(): Promise<string | undefined> {
  const path = await open({ multiple: false, filters: [{ name: 'Aplot Chat', extensions: ['json', 'md', 'markdown'] }] });
  return typeof path === 'string' ? invoke<string>('chat_import_file', { path }) : undefined;
}
