import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => mocks.desktop }));

import { invoke } from '@tauri-apps/api/core';
import {
  importProjectFile,
  exportProjectFile,
  listProjectFiles,
  readProjectFile,
  readProjectFileAttachment,
  removeProjectFile,
  searchProjectFiles,
} from '../src/services/projectFiles';

const file = {
  id: 'managed-1', projectId: 'project-1', name: 'brief.txt', mime: 'text/plain', bytes: 12,
  sha256: 'abc', version: 3, createdAt: '2026-11-03T10:00:00Z', indexed: true, truncated: false,
};

beforeEach(() => { mocks.desktop = true; vi.mocked(invoke).mockReset(); });
afterEach(() => vi.clearAllMocks());

it('calls the project-scoped native commands with the declared argument names', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(file).mockResolvedValueOnce([file]).mockResolvedValueOnce({ name: file.name, mime: file.mime, text: 'hello' }).mockResolvedValueOnce(undefined).mockResolvedValueOnce([{ file, snippet: 'hello' }]).mockResolvedValueOnce(undefined);

  await expect(importProjectFile('project-1', 'C:\\source\\brief.txt')).resolves.toEqual(file);
  await expect(listProjectFiles('project-1')).resolves.toEqual([file]);
  await expect(readProjectFile('project-1', 'managed-1')).resolves.toEqual({ name: file.name, mime: file.mime, text: 'hello' });
  await expect(removeProjectFile('project-1', 'managed-1')).resolves.toBeUndefined();
  await expect(searchProjectFiles('project-1', 'hello')).resolves.toEqual([{ file, snippet: 'hello' }]);
  await expect(exportProjectFile('project-1', 'managed-1', 'D:\\exports\\brief.txt')).resolves.toBeUndefined();

  expect(invoke).toHaveBeenNthCalledWith(1, 'project_files_import', { projectId: 'project-1', path: 'C:\\source\\brief.txt' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'project_files_list', { projectId: 'project-1' });
  expect(invoke).toHaveBeenNthCalledWith(3, 'project_files_read', { projectId: 'project-1', id: 'managed-1' });
  expect(invoke).toHaveBeenNthCalledWith(4, 'project_files_remove', { projectId: 'project-1', id: 'managed-1' });
  expect(invoke).toHaveBeenNthCalledWith(5, 'project_files_search', { projectId: 'project-1', query: 'hello' });
  expect(invoke).toHaveBeenNthCalledWith(6, 'project_files_export', { projectId: 'project-1', id: 'managed-1', path: 'D:\\exports\\brief.txt' });
});

it('returns empty lists in browser previews and keeps mutations desktop-only', async () => {
  mocks.desktop = false;
  await expect(listProjectFiles('project-1')).resolves.toEqual([]);
  await expect(searchProjectFiles('project-1', 'hello')).resolves.toEqual([]);
  await expect(importProjectFile('project-1', 'brief.txt')).rejects.toThrow('desktop application');
  await expect(readProjectFile('project-1', 'managed-1')).rejects.toThrow('desktop application');
  await expect(removeProjectFile('project-1', 'managed-1')).rejects.toThrow('desktop application');
  await expect(exportProjectFile('project-1', 'managed-1', 'brief.txt')).rejects.toThrow('desktop application');
  expect(invoke).not.toHaveBeenCalled();
});

it('maps a managed image to an explicit transient chat attachment without a filesystem path', async () => {
  vi.mocked(invoke).mockResolvedValue({ name: 'diagram.png', mime: 'image/png', data: 'data:image/png;base64,AA==' });

  const attachment = await readProjectFileAttachment('project-1', 'managed-image');

  expect(invoke).toHaveBeenCalledWith('project_files_read', { projectId: 'project-1', id: 'managed-image' });
  expect(attachment).toMatchObject({ name: 'diagram.png', kind: 'image', data: 'data:image/png;base64,AA==' });
  expect(attachment.id).toEqual(expect.any(String));
  expect(attachment).not.toHaveProperty('path');
});
