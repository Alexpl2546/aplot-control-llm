import { invoke } from '@tauri-apps/api/core';

export type GitWorkspaceState = 'ready' | 'not_repository' | 'git_missing' | 'unavailable';

export interface GitChangedFile {
  path: string;
  previousPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  diffable: boolean;
}

export interface GitWorkspaceStatus {
  state: GitWorkspaceState;
  branch: string | null;
  files: GitChangedFile[];
  truncated: boolean;
  reason: string | null;
}

export interface GitDiffSection {
  text: string;
  truncated: boolean;
  notice: string | null;
}

export interface GitWorkspaceDiff {
  path: string;
  staged: GitDiffSection;
  unstaged: GitDiffSection;
  untracked: GitDiffSection;
}

/** Fetch status by task ID. The native side resolves the task's saved project root. */
export function getGitWorkspaceStatus(taskId: string): Promise<GitWorkspaceStatus> {
  return invoke<GitWorkspaceStatus>('git_workspace_status', { taskId });
}

/** Fetch a bounded diff for a repository-relative path returned by status. */
export function getGitWorkspaceDiff(taskId: string, relativePath: string): Promise<GitWorkspaceDiff> {
  return invoke<GitWorkspaceDiff>('git_workspace_diff', { taskId, relativePath });
}
