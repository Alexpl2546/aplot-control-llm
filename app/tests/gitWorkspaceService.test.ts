import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getGitWorkspaceDiff, getGitWorkspaceStatus } from '../src/services/gitWorkspace';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

it('invokes the Git bridge with task IDs and validated relative paths only', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ state: 'ready', branch: 'main', files: [], truncated: false, reason: null });
  vi.mocked(invoke).mockResolvedValueOnce({ path: 'src/main.rs', staged: { text: '', truncated: false, notice: null }, unstaged: { text: '', truncated: false, notice: null }, untracked: { text: '', truncated: false, notice: null } });
  await getGitWorkspaceStatus('task-1');
  await getGitWorkspaceDiff('task-1', 'src/main.rs');
  expect(invoke).toHaveBeenNthCalledWith(1, 'git_workspace_status', { taskId: 'task-1' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'git_workspace_diff', { taskId: 'task-1', relativePath: 'src/main.rs' });
});
