// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  desktop: true,
  open: vi.fn(),
  save: vi.fn(),
  importProjectFile: vi.fn(),
  exportProjectFile: vi.fn(),
  listProjectFiles: vi.fn(),
  readProjectFileAttachment: vi.fn(),
  removeProjectFile: vi.fn(),
  searchProjectFiles: vi.fn(),
}));

const translate = (key: string, options: Record<string, unknown> = {}) => {
  const template = String(options.defaultValue ?? key);
  return template.replace(/\{\{([^}]+)\}\}/g, (_whole, name: string) => String(options[name] ?? ''));
};

vi.mock('../src/services/filePicker', () => ({ open: mocks.open, save: mocks.save }));
vi.mock('../src/services/tauri', () => ({ isTauri: () => mocks.desktop }));
vi.mock('../src/services/projectFiles', () => ({
  importProjectFile: mocks.importProjectFile,
  exportProjectFile: mocks.exportProjectFile,
  listProjectFiles: mocks.listProjectFiles,
  readProjectFileAttachment: mocks.readProjectFileAttachment,
  removeProjectFile: mocks.removeProjectFile,
  searchProjectFiles: mocks.searchProjectFiles,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }));
vi.mock('../src/features/agent/WorkspacePanels', () => ({
  WorkspaceDialog: ({ title, children, onClose }: { title: string; children: import('react').ReactNode; onClose: () => void }) => <div role="dialog" aria-label={title}><button type="button" onClick={onClose}>Close</button>{children}</div>,
}));
vi.mock('../src/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, title, text, confirmLabel, onCancel, onConfirm }: { open: boolean; title: string; text: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) => open
    ? <div role="dialog"><h2>{title}</h2><p>{text}</p><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={onConfirm}>{confirmLabel}</button></div>
    : null,
}));

import { ProjectFilesPanel } from '../src/features/files/ProjectFilesPanel';
import { exportProjectFile, importProjectFile, listProjectFiles, readProjectFileAttachment, removeProjectFile, searchProjectFiles } from '../src/services/projectFiles';
import { open, save } from '../src/services/filePicker';

const file = (id: string, name: string) => ({
  id, projectId: 'project-a', name, mime: 'text/plain', bytes: 128, sha256: `${id}-hash`, version: 1,
  createdAt: '2026-11-03T10:00:00Z', indexed: true, truncated: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.desktop = true;
  vi.clearAllMocks();
  vi.mocked(listProjectFiles).mockResolvedValue([]);
  vi.mocked(searchProjectFiles).mockResolvedValue([]);
  vi.mocked(importProjectFile).mockResolvedValue(file('imported', 'imported.txt'));
  vi.mocked(exportProjectFile).mockResolvedValue(undefined);
  vi.mocked(readProjectFileAttachment).mockResolvedValue({ id: 'attachment-1', name: 'brief.txt', kind: 'file', text: 'hello' });
  vi.mocked(removeProjectFile).mockResolvedValue(undefined);
});

afterEach(cleanup);

it('imports files sequentially, shows partial failures, and refreshes successful rows', async () => {
  const user = userEvent.setup();
  const first = deferred<ReturnType<typeof file>>();
  const imported = file('managed-first', 'first.txt');
  vi.mocked(open).mockResolvedValueOnce(['C:\\Users\\User\\first.txt', 'C:\\Users\\User\\second.docx']);
  vi.mocked(listProjectFiles).mockResolvedValueOnce([]).mockResolvedValueOnce([imported]);
  vi.mocked(importProjectFile).mockImplementation((_projectId, path) => path.endsWith('first.txt') ? first.promise : Promise.reject(new Error('Unsupported document.')));

  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('No files have been imported into this project yet.');
  await user.click(screen.getByRole('button', { name: 'Import files' }));
  await waitFor(() => expect(importProjectFile).toHaveBeenCalledTimes(1));
  expect(importProjectFile).toHaveBeenCalledWith('project-a', 'C:\\Users\\User\\first.txt');

  first.resolve(imported);
  expect(await screen.findByText('first.txt')).toBeTruthy();
  expect((await screen.findByRole('alert')).textContent).toContain('second.docx: This file could not be imported.');
  expect(screen.getByRole('status').textContent).toContain('Imported 1 project file(s).');
  expect(importProjectFile).toHaveBeenCalledTimes(2);
  expect(listProjectFiles).toHaveBeenCalledTimes(2);
  const pickerOptions = vi.mocked(open).mock.calls[0][0];
  expect(pickerOptions.filters?.[0].extensions).toEqual(expect.arrayContaining(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'xlsx']));
  expect(pickerOptions.filters?.[0].extensions).not.toContain('bmp');
  expect(pickerOptions.filters?.[0].extensions).not.toContain('tif');
  expect(pickerOptions.filters?.[0].extensions).not.toContain('tiff');
  expect(screen.queryByText(/C:\\Users\\User/)).toBeNull();
});

it('shows a translated generic import failure instead of native ZIP or path details', async () => {
  const user = userEvent.setup();
  vi.mocked(open).mockResolvedValueOnce(['C:\\secret\\broken.docx']);
  vi.mocked(importProjectFile).mockRejectedValueOnce(new Error('project-file-import: invalid office ZIP package at C:\\secret\\broken.docx'));
  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('No files have been imported into this project yet.');

  await user.click(screen.getByRole('button', { name: 'Import files' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('broken.docx: This file could not be imported.');
  expect(alert.textContent).not.toContain('ZIP');
  expect(alert.textContent).not.toContain('C:\\secret');
});

it('limits each picker selection to eight imports', async () => {
  const user = userEvent.setup();
  vi.mocked(open).mockResolvedValueOnce(Array.from({ length: 9 }, (_, index) => `C:\\files\\${index}.txt`));
  vi.mocked(importProjectFile).mockImplementation(async (_projectId, path) => file(path, path.split('\\').pop() ?? 'file.txt'));

  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('No files have been imported into this project yet.');
  await user.click(screen.getByRole('button', { name: 'Import files' }));

  await waitFor(() => expect(importProjectFile).toHaveBeenCalledTimes(8));
  expect((await screen.findByRole('alert')).textContent).toContain('Only the first 8 selected files were imported.');
  expect(listProjectFiles).toHaveBeenCalledTimes(2);
});

it('ignores a late project list result after switching projects', async () => {
  const oldProject = deferred<ReturnType<typeof file>[]>();
  const newProject = deferred<ReturnType<typeof file>[]>();
  vi.mocked(listProjectFiles).mockImplementation(projectId => projectId === 'project-a' ? oldProject.promise : newProject.promise);
  const view = render(<ProjectFilesPanel projectId="project-a"/>);

  view.rerender(<ProjectFilesPanel projectId="project-b"/>);
  newProject.resolve([{ ...file('current', 'current-project.txt'), projectId: 'project-b' }]);
  expect(await screen.findByText('current-project.txt')).toBeTruthy();
  oldProject.resolve([file('stale', 'stale-project.txt')]);
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(screen.getByText('current-project.txt')).toBeTruthy();
  expect(screen.queryByText('stale-project.txt')).toBeNull();
});

it('searches in the selected project and ignores a stale result after switching projects', async () => {
  const oldSearch = deferred<{ file: ReturnType<typeof file>; snippet: string }[]>();
  const newSearch = deferred<{ file: ReturnType<typeof file>; snippet: string }[]>();
  vi.mocked(searchProjectFiles).mockImplementation(projectId => projectId === 'project-a' ? oldSearch.promise : newSearch.promise);
  const view = render(<ProjectFilesPanel projectId="project-a"/>);
  const search = screen.getByRole('searchbox', { name: 'Search project files' });
  fireEvent.change(search, { target: { value: 'budget' } });
  await waitFor(() => expect(searchProjectFiles).toHaveBeenCalledWith('project-a', 'budget'));

  view.rerender(<ProjectFilesPanel projectId="project-b"/>);
  await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search project files' }) as HTMLInputElement).value).toBe(''));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project files' }), { target: { value: 'budget' } });
  await waitFor(() => expect(searchProjectFiles).toHaveBeenCalledWith('project-b', 'budget'));
  newSearch.resolve([{ file: { ...file('new-hit', 'new-hit.txt'), projectId: 'project-b' }, snippet: '<img src=x>' }]);
  expect(await screen.findByText('<img src=x>')).toBeTruthy();
  oldSearch.resolve([{ file: file('old-hit', 'old-hit.txt'), snippet: 'stale match' }]);
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(screen.getByText('new-hit.txt')).toBeTruthy();
  expect(screen.queryByText('old-hit.txt')).toBeNull();
  expect(screen.getByText('<img src=x>')).toBeTruthy();
});

it('offers explicit attachment from a search result when chat attachment is available', async () => {
  const user = userEvent.setup();
  const resultFile = file('managed-search-hit', 'matching-notes.txt');
  const onAttach = vi.fn();
  vi.mocked(searchProjectFiles).mockResolvedValueOnce([{ file: resultFile, snippet: 'The requested phrase is here.' }]);
  vi.mocked(readProjectFileAttachment).mockResolvedValueOnce({ id: 'attachment-search-hit', name: resultFile.name, kind: 'file', text: 'The requested phrase is here.' });
  render(<ProjectFilesPanel projectId="project-a" onAttach={onAttach}/>);
  await screen.findByText('No files have been imported into this project yet.');
  await user.type(screen.getByRole('searchbox', { name: 'Search project files' }), 'requested phrase');
  await screen.findByText('The requested phrase is here.');

  await user.click(screen.getByRole('button', { name: 'Attach to chat: matching-notes.txt, version 1' }));

  await waitFor(() => expect(readProjectFileAttachment).toHaveBeenCalledWith('project-a', 'managed-search-hit'));
  expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: 'attachment-search-hit', name: 'matching-notes.txt' }));
});

it('gives each same-name version a distinct accessible attach and remove action name', async () => {
  const first = { ...file('managed-v1', 'shared-notes.txt'), version: 1 };
  const second = { ...file('managed-v2', 'shared-notes.txt'), version: 2 };
  vi.mocked(listProjectFiles).mockResolvedValue([first, second]);
  render(<ProjectFilesPanel projectId="project-a" onAttach={vi.fn()}/>);
  await screen.findAllByText('shared-notes.txt');

  expect(screen.getAllByRole('button', { name: 'Attach to chat: shared-notes.txt, version 1' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Attach to chat: shared-notes.txt, version 2' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Remove copy: shared-notes.txt, version 1' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Remove copy: shared-notes.txt, version 2' })).toHaveLength(1);
});

it('exports the explicitly selected managed version to a chosen path without attaching it', async () => {
  const user = userEvent.setup();
  const version = { ...file('managed-report', 'report.docx'), version: 2 };
  const onAttach = vi.fn();
  vi.mocked(listProjectFiles).mockResolvedValue([version]);
  vi.mocked(save).mockResolvedValueOnce('D:\\copies\\report.docx');
  render(<ProjectFilesPanel projectId="project-a" onAttach={onAttach}/>);
  await screen.findByText('report.docx');

  await user.click(screen.getByRole('button', { name: 'Save copy as: report.docx, version 2' }));

  await waitFor(() => expect(exportProjectFile).toHaveBeenCalledWith('project-a', 'managed-report', 'D:\\copies\\report.docx'));
  expect(save).toHaveBeenCalledWith({ defaultPath: 'report.docx' });
  expect(onAttach).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('Saved report.docx.');
});

it('does not export when the save picker is cancelled', async () => {
  const user = userEvent.setup();
  vi.mocked(listProjectFiles).mockResolvedValue([file('managed-report', 'report.pdf')]);
  vi.mocked(save).mockResolvedValueOnce(null);
  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('report.pdf');

  await user.click(screen.getByRole('button', { name: 'Save copy as: report.pdf, version 1' }));

  expect(save).toHaveBeenCalledWith({ defaultPath: 'report.pdf' });
  expect(exportProjectFile).not.toHaveBeenCalled();
  expect(screen.queryByText('Saved report.pdf.')).toBeNull();
});

it('ignores a save-picker result after the panel changes projects', async () => {
  const user = userEvent.setup();
  const picker = deferred<string | null>();
  vi.mocked(listProjectFiles).mockImplementation(async projectId => [{ ...file(`${projectId}-file`, `${projectId}.txt`), projectId }]);
  vi.mocked(save).mockReturnValueOnce(picker.promise);
  const view = render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('project-a.txt');
  await user.click(screen.getByRole('button', { name: 'Save copy as: project-a.txt, version 1' }));
  expect(screen.getByRole('button', { name: 'Save copy as: project-a.txt, version 1' })).toHaveProperty('disabled', true);

  view.rerender(<ProjectFilesPanel projectId="project-b"/>);
  await screen.findByText('project-b.txt');
  picker.resolve('D:\\copies\\project-a.txt');
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(exportProjectFile).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save copy as: project-b.txt, version 1' })).toHaveProperty('disabled', false);
});

it('shows a concise translated message when native export fails', async () => {
  const user = userEvent.setup();
  vi.mocked(listProjectFiles).mockResolvedValue([file('managed-report', 'report.xlsx')]);
  vi.mocked(save).mockResolvedValueOnce('D:\\copies\\report.xlsx');
  vi.mocked(exportProjectFile).mockRejectedValueOnce(new Error('project-file-db: SQLITE_CORRUPT at C:\\private\\database.sqlite'));
  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('report.xlsx');

  await user.click(screen.getByRole('button', { name: 'Save copy as: report.xlsx, version 1' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('The saved copy could not be exported.');
  expect(alert.textContent).not.toContain('SQLITE_CORRUPT');
  expect(alert.textContent).not.toContain('database.sqlite');
});

it('prevents Enter in project search from submitting an enclosing chat form', () => {
  const onSubmit = vi.fn();
  render(<form onSubmit={event => { event.preventDefault(); onSubmit(); }}><ProjectFilesPanel projectId="project-a"/></form>);
  const search = screen.getByRole('searchbox', { name: 'Search project files' });
  const enter = createEvent.keyDown(search, { key: 'Enter', code: 'Enter' });

  fireEvent(search, enter);

  expect(enter.defaultPrevented).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it('only adds an attachment after an explicit click and brackets the read with onBusy', async () => {
  const user = userEvent.setup();
  const onAttach = vi.fn();
  const onBusy = vi.fn();
  vi.mocked(listProjectFiles).mockResolvedValue([file('managed-1', 'brief.txt')]);
  render(<ProjectFilesPanel projectId="project-a" onAttach={onAttach} onBusy={onBusy}/>);
  await screen.findByText('brief.txt');
  expect(onAttach).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Attach to chat: brief.txt, version 1' }));
  await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
  expect(readProjectFileAttachment).toHaveBeenCalledWith('project-a', 'managed-1');
  expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: 'attachment-1', kind: 'file' }));
  expect(onAttach.mock.calls[0][0]).not.toHaveProperty('path');
  expect(onBusy.mock.calls.map(call => call[0])).toEqual([true, false]);
});

it('maps native image/PDF size errors to a concise message', async () => {
  const user = userEvent.setup();
  const onAttach = vi.fn();
  vi.mocked(listProjectFiles).mockResolvedValue([file('managed-1', 'large-image.png')]);
  vi.mocked(readProjectFileAttachment).mockRejectedValueOnce(new Error('attachment-limit: image payload limit 5242880'));
  render(<ProjectFilesPanel projectId="project-a" onAttach={onAttach}/>);
  await screen.findByText('large-image.png');

  await user.click(screen.getByRole('button', { name: 'Attach to chat: large-image.png, version 1' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('This image or PDF exceeds its supported size limit.');
  expect(alert.textContent).not.toContain('5242880');
  expect(onAttach).not.toHaveBeenCalled();
});

it('clears attachment busy state on unmount and ignores the old read after remount', async () => {
  const user = userEvent.setup();
  const oldRead = deferred<{ id: string; name: string; kind: 'file'; text: string }>();
  const newRead = deferred<{ id: string; name: string; kind: 'file'; text: string }>();
  const onAttach = vi.fn();
  const onBusy = vi.fn();
  vi.mocked(listProjectFiles).mockImplementation(async projectId => [file(`${projectId}-file`, `${projectId}.txt`)]);
  vi.mocked(readProjectFileAttachment).mockImplementation(projectId => projectId === 'project-a' ? oldRead.promise : newRead.promise);

  const oldView = render(<ProjectFilesPanel projectId="project-a" onAttach={onAttach} onBusy={onBusy}/>);
  await screen.findByText('project-a.txt');
  await user.click(screen.getByRole('button', { name: 'Attach to chat: project-a.txt, version 1' }));
  oldView.unmount();

  render(<ProjectFilesPanel projectId="project-b" onAttach={onAttach} onBusy={onBusy}/>);
  await screen.findByText('project-b.txt');
  await user.click(screen.getByRole('button', { name: 'Attach to chat: project-b.txt, version 1' }));
  oldRead.resolve({ id: 'old-attachment', name: 'project-a.txt', kind: 'file', text: 'old' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onAttach).not.toHaveBeenCalled();
  expect(onBusy.mock.calls.map(call => call[0])).toEqual([true, false, true]);

  newRead.resolve({ id: 'new-attachment', name: 'project-b.txt', kind: 'file', text: 'new' });
  await waitFor(() => expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-attachment' })));
  expect(onBusy.mock.calls.map(call => call[0])).toEqual([true, false, true, false]);
});

it('does not attach a pending project read after the same panel switches projects', async () => {
  const user = userEvent.setup();
  const oldRead = deferred<{ id: string; name: string; kind: 'file'; text: string }>();
  const newRead = deferred<{ id: string; name: string; kind: 'file'; text: string }>();
  const onAttach = vi.fn();
  const onBusy = vi.fn();
  vi.mocked(listProjectFiles).mockImplementation(async projectId => [{ ...file(`${projectId}-file`, `${projectId}.txt`), projectId }]);
  vi.mocked(readProjectFileAttachment).mockImplementation(projectId => projectId === 'project-a' ? oldRead.promise : newRead.promise);

  const view = render(<ProjectFilesPanel projectId="project-a" onAttach={onAttach} onBusy={onBusy}/>);
  await screen.findByText('project-a.txt');
  await user.click(screen.getByRole('button', { name: 'Attach to chat: project-a.txt, version 1' }));
  view.rerender(<ProjectFilesPanel projectId="project-b" onAttach={onAttach} onBusy={onBusy}/>);
  await screen.findByText('project-b.txt');
  await user.click(screen.getByRole('button', { name: 'Attach to chat: project-b.txt, version 1' }));

  oldRead.resolve({ id: 'old-attachment', name: 'project-a.txt', kind: 'file', text: 'old' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onAttach).not.toHaveBeenCalled();
  expect(onBusy.mock.calls.map(call => call[0])).toEqual([true, false, true]);

  newRead.resolve({ id: 'new-attachment', name: 'project-b.txt', kind: 'file', text: 'new' });
  await waitFor(() => expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-attachment' })));
  expect(onBusy.mock.calls.map(call => call[0])).toEqual([true, false, true, false]);
});

it('keeps the managed-copy confirmation wording and removes only after confirmation', async () => {
  const user = userEvent.setup();
  vi.mocked(listProjectFiles).mockResolvedValueOnce([file('managed-1', 'brief.txt')]).mockResolvedValueOnce([]);
  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('brief.txt');

  await user.click(screen.getByRole('button', { name: 'Remove copy: brief.txt, version 1' }));
  expect(screen.getByRole('dialog').textContent).toContain('This removes the managed copy only. The project file will stay unchanged.');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(removeProjectFile).not.toHaveBeenCalled();
  expect(screen.getByText('brief.txt')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Remove copy: brief.txt, version 1' }));
  await user.click(screen.getByRole('button', { name: 'Remove copy' }));
  await waitFor(() => expect(removeProjectFile).toHaveBeenCalledWith('project-a', 'managed-1'));
  await waitFor(() => expect(screen.queryByText('brief.txt')).toBeNull());
  expect(listProjectFiles).toHaveBeenCalledTimes(2);
});

it('clears active search results after successful import and removal', async () => {
  const user = userEvent.setup();
  const existing = file('managed-existing', 'existing.txt');
  const imported = file('managed-imported', 'imported.txt');
  vi.mocked(listProjectFiles).mockResolvedValueOnce([existing]).mockResolvedValueOnce([existing, imported]).mockResolvedValueOnce([]);
  vi.mocked(searchProjectFiles).mockResolvedValue([{ file: existing, snippet: 'needle in existing file' }]);
  vi.mocked(open).mockResolvedValueOnce('C:\\files\\imported.txt');

  render(<ProjectFilesPanel projectId="project-a"/>);
  await screen.findByText('existing.txt');
  const search = screen.getByRole('searchbox', { name: 'Search project files' });
  fireEvent.change(search, { target: { value: 'needle' } });
  expect(await screen.findByText('needle in existing file')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Import files' }));
  await screen.findByText('imported.txt');
  await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search project files' }) as HTMLInputElement).value).toBe(''));
  expect(screen.queryByText('needle in existing file')).toBeNull();

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project files' }), { target: { value: 'needle' } });
  expect(await screen.findByText('needle in existing file')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Remove copy: existing.txt, version 1' }));
  await user.click(screen.getByRole('button', { name: 'Remove copy' }));
  await waitFor(() => expect(removeProjectFile).toHaveBeenCalledWith('project-a', 'managed-existing'));
  await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search project files' }) as HTMLInputElement).value).toBe(''));
  expect(screen.queryByText('needle in existing file')).toBeNull();
});
