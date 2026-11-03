// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockData = vi.hoisted(() => {
  const fixture = { id: 'artifact-1', taskId: 'task-1', sourceRelative: 'reports/final.docx', name: 'final.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 2048, sha256: 'abc123', version: 2, createdAt: '2026-11-02T12:00:00Z' };
  return { fixture, artifacts: [fixture] };
});
const { fixture, artifacts } = mockData;
const mockTranslate = vi.hoisted(() => (key: string, options?: { defaultValue?: string; version?: number }) => options?.defaultValue?.replace('{{version}}', String(options.version ?? '')) ?? key);
vi.mock('../src/services/userArtifacts', () => ({
  listUserArtifacts: vi.fn().mockResolvedValue(mockData.artifacts),
  saveUserArtifact: vi.fn().mockResolvedValue(mockData.fixture),
  openUserArtifact: vi.fn().mockResolvedValue(undefined),
  removeUserArtifact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: mockTranslate }) }));
vi.mock('../src/components/ui/ConfirmDialog', () => ({ ConfirmDialog: ({ open, confirmLabel, onCancel, onConfirm }: { open: boolean; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) => open ? <div role="dialog"><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={onConfirm}>{confirmLabel}</button></div> : null }));

import { ArtifactsPanel } from '../src/features/agent/ArtifactsPanel';
import { listUserArtifacts, openUserArtifact, removeUserArtifact, saveUserArtifact } from '../src/services/userArtifacts';

beforeEach(() => { vi.clearAllMocks(); vi.mocked(listUserArtifacts).mockResolvedValue(artifacts); });
afterEach(cleanup);

it('saves only the explicit relative project file and refreshes its versions', async () => {
  const user = userEvent.setup();
  render(<ArtifactsPanel taskId="task-1"/>);
  await screen.findByText('final.docx');
  await user.type(screen.getByRole('textbox', { name: 'Project file path' }), 'reports/final.docx');
  await user.click(screen.getByRole('button', { name: 'Save result' }));
  await waitFor(() => expect(saveUserArtifact).toHaveBeenCalledWith('task-1', 'reports/final.docx'));
  expect(listUserArtifacts).toHaveBeenCalledWith('task-1');
});

it('opens and removes only a managed artifact id', async () => {
  render(<ArtifactsPanel taskId="task-1"/>);
  await screen.findByText('final.docx');
  fireEvent.click(screen.getByRole('button', { name: 'Open saved copy' }));
  await waitFor(() => expect(openUserArtifact).toHaveBeenCalledWith('task-1', 'artifact-1'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove saved copy: final.docx' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove copy' }));
  await waitFor(() => expect(removeUserArtifact).toHaveBeenCalledWith('task-1', 'artifact-1'));
});

it('rejects an absolute path before calling the native save command', async () => {
  const user = userEvent.setup();
  render(<ArtifactsPanel taskId="task-1"/>);
  await user.type(screen.getByRole('textbox', { name: 'Project file path' }), 'C:\\Users\\me\\final.docx');
  await user.click(screen.getByRole('button', { name: 'Save result' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Enter a file path relative to this project.');
  expect(saveUserArtifact).not.toHaveBeenCalled();
});
