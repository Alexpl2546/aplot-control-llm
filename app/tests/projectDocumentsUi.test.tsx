// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  desktop: true,
}));

vi.mock('../src/services/projectDocuments', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/projectDocuments')>();
  return { ...actual, createProjectDocument: mocks.create };
});
vi.mock('../src/services/tauri', () => ({ isTauri: () => mocks.desktop }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../src/features/agent/WorkspacePanels', () => ({
  WorkspaceDialog: ({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) => (
    <dialog open aria-label={title}>
      <header><h2>{title}</h2><button type="button" aria-label="close dialog" onClick={onClose}>×</button></header>
      {children}
    </dialog>
  ),
}));

import { DocumentComposer } from '../src/features/files/DocumentComposer';
import { createProjectDocument } from '../src/services/projectDocuments';
import type { ProjectFile } from '../src/services/projectFiles';

const file: ProjectFile = {
  id: 'generated-1',
  projectId: 'project-a',
  name: 'summary.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytes: 300,
  sha256: 'hash',
  version: 1,
  createdAt: '2026-11-03T10:00:00Z',
  indexed: true,
  truncated: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fillDocxForm(user: ReturnType<typeof userEvent.setup>) {
  return (async () => {
    await user.type(screen.getByLabelText('documentCreate.titleLabel'), 'Summary');
    await user.type(screen.getByLabelText('documentCreate.fileNameLabel'), 'summary');
    await user.type(screen.getByLabelText('documentCreate.contentLabel'), '# Overview\n\nHello world.');
  })();
}

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.desktop = true; });

it('keeps typing local until submit, then sends the generated request and returned file to the parent', async () => {
  const user = userEvent.setup();
  const onCreated = vi.fn();
  const onClose = vi.fn();
  vi.mocked(createProjectDocument).mockResolvedValueOnce(file);
  render(<DocumentComposer projectId="project-a" onCreated={onCreated} onClose={onClose}/>);

  await fillDocxForm(user);
  expect(createProjectDocument).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(file));
  expect(createProjectDocument).toHaveBeenCalledWith('project-a', {
    name: 'summary.docx',
    content: {
      format: 'docx',
      document: {
        title: 'Summary',
        blocks: [
          { type: 'heading', level: 1, text: 'Overview' },
          { type: 'paragraph', text: 'Hello world.' },
        ],
      },
    },
  });
  expect(onClose).toHaveBeenCalledOnce();
});

it('reports bad names and malformed CSV locally without creating a project file', async () => {
  const user = userEvent.setup();
  render(<DocumentComposer projectId="project-a" onCreated={vi.fn()} onClose={vi.fn()}/>);

  await user.type(screen.getByLabelText('documentCreate.titleLabel'), 'Data');
  await user.type(screen.getByLabelText('documentCreate.fileNameLabel'), '../bad');
  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));
  expect(screen.getByRole('alert').textContent).toBe('documentCreate.invalidFilename');
  expect(createProjectDocument).not.toHaveBeenCalled();

  await user.clear(screen.getByLabelText('documentCreate.fileNameLabel'));
  await user.type(screen.getByLabelText('documentCreate.fileNameLabel'), 'data');
  await user.selectOptions(screen.getByLabelText('documentCreate.formatLabel'), 'xlsx');
  await user.type(screen.getByLabelText('documentCreate.csvLabel'), 'Name,Value\n"unfinished,=SUM(A1:A2)');
  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));
  expect(screen.getByRole('alert').textContent).toBe('documentCreate.invalidCsv');
  expect(createProjectDocument).not.toHaveBeenCalled();
});

it('rejects DOCX/PDF tables above eight columns or 200 data rows before invoking native creation', async () => {
  const user = userEvent.setup();
  render(<DocumentComposer projectId="project-a" onCreated={vi.fn()} onClose={vi.fn()}/>);
  await user.type(screen.getByLabelText('documentCreate.titleLabel'), 'Table');
  await user.type(screen.getByLabelText('documentCreate.fileNameLabel'), 'table');
  const editor = screen.getByLabelText('documentCreate.contentLabel');

  const headers = Array.from({ length: 9 }, (_value, index) => `c${index}`);
  const wideTable = [`|${headers.join('|')}|`, `|${headers.map(() => '---').join('|')}|`].join('\n');
  fireEvent.change(editor, { target: { value: wideTable } });
  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));
  expect(screen.getByRole('alert').textContent).toBe('documentCreate.invalidContent');
  expect(createProjectDocument).not.toHaveBeenCalled();

  const tallTable = ['|value|', '|---|', ...Array.from({ length: 201 }, () => '|x|')].join('\n');
  fireEvent.change(editor, { target: { value: tallTable } });
  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));
  expect(screen.getByRole('alert').textContent).toBe('documentCreate.invalidContent');
  expect(createProjectDocument).not.toHaveBeenCalled();
});

it('cancels without creating a file', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<DocumentComposer projectId="project-a" onCreated={vi.fn()} onClose={onClose}/>);
  await user.click(screen.getByRole('button', { name: 'documentCreate.cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(createProjectDocument).not.toHaveBeenCalled();
});

it('maps unsupported PDF glyph failures to a short translated message', async () => {
  const user = userEvent.setup();
  vi.mocked(createProjectDocument).mockRejectedValueOnce(new Error('document-pdf-glyph: unsupported glyph U+1F680'));
  render(<DocumentComposer projectId="project-a" onCreated={vi.fn()} onClose={vi.fn()}/>);
  await user.type(screen.getByLabelText('documentCreate.titleLabel'), 'Report');
  await user.type(screen.getByLabelText('documentCreate.fileNameLabel'), 'report');
  await user.selectOptions(screen.getByLabelText('documentCreate.formatLabel'), 'pdf');
  await user.type(screen.getByLabelText('documentCreate.contentLabel'), 'A report.');
  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));

  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('documentCreate.unsupportedGlyph'));
  expect(screen.getByRole('alert').textContent).not.toContain('U+1F680');
});

it('prevents Enter in text fields from implicitly submitting the surrounding chat form', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn(event => event.preventDefault());
  render(<form onSubmit={onSubmit}><DocumentComposer projectId="project-a" onCreated={vi.fn()} onClose={vi.fn()}/></form>);

  const title = screen.getByLabelText('documentCreate.titleLabel');
  await user.type(title, 'Draft');
  await user.keyboard('{Enter}');
  expect(onSubmit).not.toHaveBeenCalled();
  expect(createProjectDocument).not.toHaveBeenCalled();
});

it('prevents duplicate submit and ignores a file result after the project changes', async () => {
  const user = userEvent.setup();
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const pending = deferred<ProjectFile>();
  vi.mocked(createProjectDocument).mockReturnValueOnce(pending.promise);
  const view = render(<DocumentComposer projectId="project-a" onCreated={onCreated} onClose={onClose}/>);

  await fillDocxForm(user);
  const createButton = screen.getByRole('button', { name: 'documentCreate.save' });
  await user.click(createButton);
  expect((screen.getByRole('button', { name: 'documentCreate.creating' }) as HTMLButtonElement).disabled).toBe(true);
  expect(createProjectDocument).toHaveBeenCalledOnce();

  const dialog = screen.getByRole('dialog');
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  fireEvent.click(screen.getByRole('button', { name: 'close dialog' }));
  expect(onClose).not.toHaveBeenCalled();

  view.rerender(<DocumentComposer projectId="project-b" onCreated={onCreated} onClose={onClose}/>);
  pending.resolve({ ...file, projectId: 'project-a' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'documentCreate.save' }) as HTMLButtonElement).disabled).toBe(false));
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('does not expose a file-creation action in browser previews', async () => {
  mocks.desktop = false;
  const user = userEvent.setup();
  render(<DocumentComposer projectId="project-a" onCreated={vi.fn()} onClose={vi.fn()}/>);
  expect(screen.getByRole('status').textContent).toBe('documentCreate.desktopOnly');
  expect((screen.getByRole('button', { name: 'documentCreate.save' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'documentCreate.save' }));
  expect(createProjectDocument).not.toHaveBeenCalled();
});
