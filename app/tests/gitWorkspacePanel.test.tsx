// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitPanel } from '../src/features/agent/GitPanel';
import { getGitWorkspaceDiff, getGitWorkspaceStatus } from '../src/services/gitWorkspace';

vi.mock('../src/services/gitWorkspace', () => ({
  getGitWorkspaceDiff: vi.fn(),
  getGitWorkspaceStatus: vi.fn(),
}));

const changed = {
  path: 'src/main.rs', previousPath: null, indexStatus: ' ', worktreeStatus: 'M',
  staged: false, unstaged: true, untracked: false, conflicted: false, diffable: true,
};
const ready = { state: 'ready' as const, branch: 'work/git-panel', files: [changed], truncated: false, reason: null };
const preview = { path: changed.path, staged: { text: '', truncated: false, notice: null }, unstaged: { text: '--- a/src/main.rs\n+++ b/src/main.rs\n-old\n+new\n', truncated: false, notice: null }, untracked: { text: '', truncated: false, notice: null } };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('loads status and a safe selected-file preview using the task ID and relative path', async () => {
  vi.mocked(getGitWorkspaceStatus).mockResolvedValue(ready);
  vi.mocked(getGitWorkspaceDiff).mockResolvedValue(preview);
  render(<GitPanel taskId="task-7"/>);
  expect(await screen.findByText('work/git-panel')).toBeTruthy();
  expect(await screen.findByText('new', { exact: false })).toBeTruthy();
  expect(getGitWorkspaceStatus).toHaveBeenCalledWith('task-7');
  expect(getGitWorkspaceDiff).toHaveBeenCalledWith('task-7', 'src/main.rs');
  expect(screen.queryByText(/C:\\/)).toBeNull();
});

it('refreshes manually and changes the selected file preview', async () => {
  const second = { ...changed, path: 'README.md' };
  vi.mocked(getGitWorkspaceStatus).mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, files: [second] });
  vi.mocked(getGitWorkspaceDiff).mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, path: 'README.md', unstaged: { ...preview.unstaged, text: '+updated README\n' } });
  render(<GitPanel taskId="task-2"/>);
  await screen.findByText('work/git-panel');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Git status' }));
  await waitFor(() => expect(screen.getByText(/updated README/)).toBeTruthy());
  expect(getGitWorkspaceStatus).toHaveBeenCalledTimes(2);
  expect(getGitWorkspaceDiff).toHaveBeenLastCalledWith('task-2', 'README.md');
});

it.each([
  [{ state: 'not_repository', branch: null, files: [], truncated: false, reason: null }, /not a Git repository/],
  [{ state: 'git_missing', branch: null, files: [], truncated: false, reason: null }, /Git was not found/],
])('explains unavailable Git state without requiring raw path input', async (status, message) => {
  vi.mocked(getGitWorkspaceStatus).mockResolvedValue(status as never);
  render(<GitPanel taskId="task-3"/>);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(getGitWorkspaceDiff).not.toHaveBeenCalled();
});
