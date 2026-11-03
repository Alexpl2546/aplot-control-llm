// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../src/features/agent/WorkspacePanels', () => ({
  WorkspaceDialog: ({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) => <section><h3>{title}</h3><button type="button" onClick={onClose}>Mock close</button>{children}</section>,
}));

import { invoke } from '@tauri-apps/api/core';
import { FilePickerHost } from '../src/features/filePicker/FilePickerHost';
import { defaultFolderForFilePath, save, useFilePicker } from '../src/services/filePicker';

const places = [
  { kind: 'home' as const, name: 'Home', path: 'C:\\Users\\Tester' },
  { kind: 'documents' as const, name: 'Documents', path: 'C:\\Users\\Tester\\Documents' },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useFilePicker.setState({ request: undefined });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'browse_places') return places as never;
    if (command === 'browse_folder') return { path: String(args?.path ?? ''), parent: null, entries: [] } as never;
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  useFilePicker.setState({ request: undefined });
});

it.each([
  ['bare filename', 'report.docx', undefined],
  ['relative path', 'reports\\report.docx', undefined],
  ['Windows drive root', 'C:\\report.docx', 'C:\\'],
  ['Windows directory', 'C:\\Users\\Tester\\report.docx', 'C:\\Users\\Tester'],
  ['UNC share root', '\\\\server\\share\\report.docx', '\\\\server\\share'],
  ['UNC subfolder', '\\\\server\\share\\folder\\report.docx', '\\\\server\\share\\folder'],
  ['Unix root', '/report.pdf', '/'],
  ['Unix directory', '/home/tester/report.pdf', '/home/tester'],
  ['extended Windows drive root', '\\\\?\\C:\\report.docx', '\\\\?\\C:\\'],
])('derives an absolute parent folder for %s', (_label, path, expected) => {
  expect(defaultFolderForFilePath(path)).toBe(expected);
});

it.each([
  { label: 'last folder', previous: 'D:\\Previous', expected: 'D:\\Previous' },
  { label: 'Documents fallback', previous: undefined, expected: 'C:\\Users\\Tester\\Documents' },
])('opens a save picker for a bare filename in the $label folder and keeps the filename', async ({ previous, expected }) => {
  if (previous) localStorage.setItem('aplot.picker.last', previous);
  const result = save({ defaultPath: 'report.docx' });
  render(<FilePickerHost/>);

  await waitFor(() => expect(invoke).toHaveBeenCalledWith('browse_folder', { path: expected }));
  expect(screen.getByRole('textbox', { name: 'picker.fileName' })).toHaveProperty('value', 'report.docx');
  fireEvent.click(screen.getByRole('button', { name: 'aw.cancel' }));
  await expect(result).resolves.toBeNull();
});
