import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getGitWorkspaceDiff, getGitWorkspaceStatus, type GitChangedFile, type GitDiffSection, type GitWorkspaceDiff, type GitWorkspaceStatus } from '../../services/gitWorkspace';
import './gitPanel.css';

type Translate = (key: string, defaultValue: string, values?: Record<string, string | number>) => string;

function errorMessage(value: unknown, tr: Translate): string {
  const code = String(value).replace(/^Error:\s*/, '').toLowerCase();
  if (code.includes('task-missing') || code.includes('project-missing') || code.includes('folder')) return tr('gitPanel.errors.projectUnavailable', 'The task project folder is unavailable.');
  if (code.includes('git-missing')) return tr('gitPanel.errors.gitMissing', 'Git was not found on this system.');
  if (code.includes('not-repository')) return tr('gitPanel.errors.notRepository', 'This task folder is not a Git repository.');
  if (code.includes('changed-file-missing')) return tr('gitPanel.errors.changedFileMissing', 'That file is no longer changed. Refresh to load the current list.');
  if (code.includes('unsafe_path')) return tr('gitPanel.errors.unsafePath', 'This file path cannot be previewed safely.');
  if (code.includes('git-timeout')) return tr('gitPanel.errors.timeout', 'Git took too long to respond. Try refreshing.');
  return tr('gitPanel.errors.loadFailed', 'Git information could not be loaded.');
}

function fileStatus(file: GitChangedFile, tr: Translate): string {
  if (file.conflicted) return tr('gitPanel.status.conflict', 'Conflict');
  if (file.untracked) return tr('gitPanel.status.untracked', 'Untracked');
  if (file.staged && file.unstaged) return tr('gitPanel.status.stagedModified', 'Staged + modified');
  if (file.staged) return tr('gitPanel.status.staged', 'Staged {{status}}', { status: file.indexStatus });
  if (file.unstaged) return tr('gitPanel.status.modified', 'Modified {{status}}', { status: file.worktreeStatus });
  return `${file.indexStatus}${file.worktreeStatus}`.trim() || tr('gitPanel.status.changed', 'Changed');
}

function sectionNotice(notice: string | null, tr: Translate): string | undefined {
  if (!notice) return undefined;
  if (notice === 'binary') return tr('gitPanel.preview.binary', 'Binary content is not previewed.');
  if (notice === 'too_large') return tr('gitPanel.preview.tooLarge', 'This file is too large for a safe preview.');
  if (notice === 'unsafe_path') return tr('gitPanel.preview.unsafePath', 'This path is outside the task project or cannot be previewed safely.');
  if (notice === 'not_a_file') return tr('gitPanel.preview.notFile', 'This changed path is not a regular file.');
  return tr('gitPanel.preview.unavailable', 'Preview is unavailable for this file.');
}

function DiffSection({ title, section, tr }: { title: string; section: GitDiffSection; tr: Translate }) {
  const notice = sectionNotice(section.notice, tr);
  if (!section.text && !notice) return null;
  return <section className="gitPanelDiffSection">
    <h4>{title}</h4>
    {notice && <p className="gitPanelNotice">{notice}</p>}
    {!!section.text && <pre>{section.text}</pre>}
    {section.truncated && <p className="gitPanelNotice">{tr('gitPanel.preview.shortened', 'Preview was shortened to keep it responsive.')}</p>}
  </section>;
}

export function GitPanel({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const tr = useCallback<Translate>((key, defaultValue, values = {}) => t(key, { defaultValue, ...values }), [t]);
  const [status, setStatus] = useState<GitWorkspaceStatus>();
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState<GitWorkspaceDiff>();
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const diffRequest = useRef(0);
  const selectedPathRef = useRef('');

  const loadDiff = useCallback(async (path: string, token: number) => {
    setDiff(undefined);
    if (!path) { setDiffLoading(false); return; }
    const file = status?.files.find(row => row.path === path);
    if (file && !file.diffable) { setDiffLoading(false); return; }
    setDiffLoading(true);
    try {
      const next = await getGitWorkspaceDiff(taskId, path);
      if (token === diffRequest.current) setDiff(next);
    } catch (value) {
      if (token === diffRequest.current) setError(errorMessage(value, tr));
    } finally {
      if (token === diffRequest.current) setDiffLoading(false);
    }
  }, [status?.files, taskId, tr]);

  const refresh = useCallback(async () => {
    const token = ++request.current;
    diffRequest.current++;
    setLoading(true);
    setError('');
    try {
      const next = await getGitWorkspaceStatus(taskId);
      if (token !== request.current) return;
      setStatus(next);
      if (next.state !== 'ready') {
        selectedPathRef.current = '';
        setSelectedPath('');
        setDiff(undefined);
        setDiffLoading(false);
        return;
      }
      const current = selectedPathRef.current;
      const selected = next.files.some(file => file.path === current) ? current : next.files[0]?.path ?? '';
      selectedPathRef.current = selected;
      setSelectedPath(selected);
      if (!selected) { setDiff(undefined); setDiffLoading(false); return; }
      const diffToken = ++diffRequest.current;
      const selectedFile = next.files.find(file => file.path === selected);
      if (selectedFile && !selectedFile.diffable) { setDiff(undefined); setDiffLoading(false); return; }
      setDiffLoading(true);
      try {
        const nextDiff = await getGitWorkspaceDiff(taskId, selected);
        if (token === request.current && diffToken === diffRequest.current) setDiff(nextDiff);
      } catch (value) {
        if (token === request.current && diffToken === diffRequest.current) setError(errorMessage(value, tr));
      } finally {
        if (token === request.current && diffToken === diffRequest.current) setDiffLoading(false);
      }
    } catch (value) {
      if (token === request.current) setError(errorMessage(value, tr));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [taskId, tr]);

  useEffect(() => {
    void refresh();
    return () => { request.current++; diffRequest.current++; };
  }, [refresh]);

  const choose = (path: string) => {
    selectedPathRef.current = path;
    setSelectedPath(path);
    setError('');
    const token = ++diffRequest.current;
    void loadDiff(path, token);
  };

  const files = status?.state === 'ready' ? status.files : [];
  const selected = files.find(file => file.path === selectedPath);
  const hasText = !!(diff?.staged.text || diff?.unstaged.text || diff?.untracked.text);

  return <section className="gitPanel" aria-label={tr('gitPanel.aria', 'Git workplace')}>
    <header className="gitPanelHeader">
      <div className="gitPanelTitle"><GitBranch size={15} aria-hidden="true"/><strong>{tr('gitPanel.title', 'Git workplace')}</strong>{status?.state === 'ready' && status.branch && <span>{status.branch}</span>}</div>
      <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={tr('gitPanel.refresh', 'Refresh Git status')} title={tr('gitPanel.refresh', 'Refresh Git status')}><RefreshCw size={15} className={loading ? 'is-spinning' : ''}/><span>{tr('gitPanel.refreshButton', 'Refresh')}</span></button>
    </header>
    {error && <p className="gitPanelError" role="alert">{error}</p>}
    {loading && !status && <p className="gitPanelEmpty" role="status">{tr('gitPanel.loading.status', 'Loading Git status…')}</p>}
    {status?.state === 'git_missing' && <p className="gitPanelEmpty" role="status">{tr('gitPanel.errors.gitMissing', 'Git was not found on this system.')}</p>}
    {status?.state === 'not_repository' && <p className="gitPanelEmpty" role="status">{tr('gitPanel.errors.notRepository', 'This task folder is not a Git repository.')}</p>}
    {status?.state === 'unavailable' && <p className="gitPanelEmpty" role="status">{status.reason === 'timeout' ? tr('gitPanel.unavailable.timeout', 'Git took too long to respond.') : status.reason === 'output_limit' ? tr('gitPanel.unavailable.outputLimit', 'Git returned too much data to preview.') : tr('gitPanel.errors.loadFailed', 'Git information could not be loaded.')}</p>}
    {status?.state === 'ready' && <div className="gitPanelBody">
      <nav className="gitPanelFiles" aria-label={tr('gitPanel.files.aria', 'Changed files')}>
        {files.length ? files.map(file => <button key={`${file.path}:${file.indexStatus}${file.worktreeStatus}`} type="button" aria-pressed={selectedPath === file.path} onClick={() => choose(file.path)} disabled={!file.diffable} title={file.path}>
          <span className="gitPanelFilePath">{file.path}</span><small>{fileStatus(file, tr)}</small>
          {file.previousPath && <span className="gitPanelPrevious">{tr('gitPanel.files.from', 'from {{path}}', { path: file.previousPath })}</span>}
        </button>) : <p className="gitPanelEmpty">{tr('gitPanel.files.none', 'No changed files.')}</p>}
        {status.truncated && <p className="gitPanelNotice">{tr('gitPanel.files.limit', 'Only the first 300 changed files are shown.')}</p>}
      </nav>
      <div className="gitPanelDiff" aria-live="polite">
        {selected && <h3 title={selected.path}>{selected.path}</h3>}
        {diffLoading && <p className="gitPanelEmpty" role="status">{tr('gitPanel.loading.diff', 'Loading diff preview…')}</p>}
        {selected && !selected.diffable && <p className="gitPanelNotice">{tr('gitPanel.preview.undecodable', 'This path could not be decoded safely, so no diff is shown.')}</p>}
        {!diffLoading && diff && <>
          <DiffSection title={tr('gitPanel.diff.staged', 'Staged changes')} section={diff.staged} tr={tr}/>
          <DiffSection title={tr('gitPanel.diff.unstaged', 'Unstaged changes')} section={diff.unstaged} tr={tr}/>
          <DiffSection title={tr('gitPanel.diff.untracked', 'Untracked file preview')} section={diff.untracked} tr={tr}/>
          {!hasText && !diff.staged.notice && !diff.unstaged.notice && !diff.untracked.notice && <p className="gitPanelEmpty">{tr('gitPanel.diff.none', 'No text diff is available for this file.')}</p>}
        </>}
        {!selected && !files.length && <p className="gitPanelEmpty">{tr('gitPanel.diff.clean', 'Working tree is clean.')}</p>}
      </div>
    </div>}
  </section>;
}
