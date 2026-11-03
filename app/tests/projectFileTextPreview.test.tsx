// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ readProjectFile: vi.fn() }));

vi.mock('../src/services/projectFiles', () => ({
  readProjectFile: mocks.readProjectFile,
}));

vi.mock('../src/features/agent/WorkspacePanels', () => ({
  WorkspaceDialog: ({
    title,
    children,
    onClose,
  }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
  }) => (
    <section role="dialog" aria-label={title}>
      <header><h2>{title}</h2><button type="button" onClick={onClose}>Close</button></header>
      {children}
    </section>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) => String(options.defaultValue ?? key),
  }),
}));

import type { ProjectFileContent } from '../src/services/projectFiles';
import { ProjectFileTextPreview } from '../src/features/files/ProjectFileTextPreview';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

it('ignores the late text result after switching from file A to file B', async () => {
  const oldRequest = deferred<ProjectFileContent>();
  const newRequest = deferred<ProjectFileContent>();
  mocks.readProjectFile.mockImplementation((_projectId: string, fileId: string) =>
    fileId === 'file-a' ? oldRequest.promise : newRequest.promise,
  );
  const view = render(
    <ProjectFileTextPreview projectId="project-a" fileId="file-a" name="old.txt" onClose={vi.fn()} />,
  );
  expect((await screen.findByRole('status')).textContent).toContain('Loading text preview…');

  view.rerender(
    <ProjectFileTextPreview projectId="project-b" fileId="file-b" name="current.txt" onClose={vi.fn()} />,
  );
  newRequest.resolve({ name: 'current.txt', mime: 'text/plain', text: 'Current file contents' });
  expect(await screen.findByText('Current file contents')).toBeTruthy();

  oldRequest.resolve({ name: 'old.txt', mime: 'text/plain', text: 'Stale file contents' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByText('Stale file contents')).toBeNull();
  expect(screen.getByText('Current file contents')).toBeTruthy();
  expect(mocks.readProjectFile).toHaveBeenNthCalledWith(1, 'project-a', 'file-a');
  expect(mocks.readProjectFile).toHaveBeenNthCalledWith(2, 'project-b', 'file-b');
});

it('renders native text as escaped text, not HTML', async () => {
  const text = '<img src=x onerror=alert(1)> & <script>do not run</script>';
  mocks.readProjectFile.mockResolvedValueOnce({ name: 'notes.txt', mime: 'text/plain', text });
  const view = render(
    <ProjectFileTextPreview projectId="project-a" fileId="file-1" name="notes.txt" onClose={vi.fn()} />,
  );

  const preview = await screen.findByText(text);
  expect(preview.tagName).toBe('PRE');
  expect(view.container.querySelector('img, script')).toBeNull();
  expect(view.container.querySelector('form')).toBeNull();
  expect(view.container.textContent).toContain('Text preview only; formatting and formula calculation are not reproduced.');
});

it('shows a generic error without exposing native errors or private paths', async () => {
  mocks.readProjectFile.mockRejectedValueOnce(new Error('secret path C:\\private\\project.sqlite: corrupt ZIP'));
  const view = render(
    <ProjectFileTextPreview projectId="project-a" fileId="file-1" name="notes.txt" onClose={vi.fn()} />,
  );

  expect((await screen.findByRole('alert')).textContent).toContain('The text preview could not be loaded.');
  expect(view.container.textContent).not.toContain('secret path');
  expect(view.container.textContent).not.toContain('project.sqlite');
});

it('shows the unavailable fallback when native content has no text', async () => {
  mocks.readProjectFile.mockResolvedValueOnce({ name: 'scan.pdf', mime: 'application/pdf', data: 'private-binary-data' });
  const view = render(
    <ProjectFileTextPreview projectId="project-a" fileId="file-1" name="scan.pdf" onClose={vi.fn()} />,
  );

  expect(await screen.findByText('Text preview is not available for this file.')).toBeTruthy();
  expect(view.container.textContent).not.toContain('private-binary-data');
  expect(view.container.querySelector('pre')).toBeNull();
});

it('caps displayed native text at 200,000 characters', async () => {
  mocks.readProjectFile.mockResolvedValueOnce({ name: 'large.txt', mime: 'text/plain', text: 'x'.repeat(200_005) });
  const view = render(
    <ProjectFileTextPreview projectId="project-a" fileId="file-1" name="large.txt" onClose={vi.fn()} />,
  );

  await waitFor(() => expect(view.container.querySelector('pre')?.textContent?.length).toBe(200_000));
});
