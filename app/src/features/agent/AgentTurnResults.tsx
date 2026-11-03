import { ExternalLink, FileCheck2, GitBranch } from 'lucide-react';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { openUserArtifact } from '../../services/userArtifacts';
import { collectTurnResults, type FileReceipt } from './agentTurnResultsModel';
import type { AgentEntry } from './store';
import './agentTurnResults.css';

function SavedCopy({ taskId, file }: { taskId: string; file: FileReceipt }) {
  const { t } = useTranslation();
  const busy = useRef(false);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = t('agent.artifacts.openCopy', { defaultValue: 'Open saved copy' });

  async function openCopy() {
    if (busy.current) return;
    busy.current = true;
    setOpening(true);
    setFailed(false);
    try {
      await openUserArtifact(taskId, file.id);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setOpening(false);
    }
  }

  return <li>
    <Button type="button" disabled={opening} aria-label={`${label}: ${file.name}`} onClick={() => void openCopy()}>
      <ExternalLink size={14} aria-hidden="true"/>{file.name}
    </Button>
    <span>{t('agent.artifacts.version', { defaultValue: 'v{{version}}', version: file.version })}</span>
    {failed && <p className="awTurnResultError" role="alert">{t('agent.artifacts.openFailed', { defaultValue: 'Could not open the saved copy.' })}</p>}
  </li>;
}

function ResultGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="awTurnResultGroup" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label} <span>· {count}</span></summary>
    {open && children}
  </details>;
}

function RecordedDiff({ path, previews }: { path: string; previews: string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details className="awTurnResultDiff" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><code>{path}</code><span>{t('aw.diff')}</span></summary>
    {open && previews.map((diff, index) => <pre key={index}>{diff}</pre>)}
  </details>;
}

export function AgentTurnResults({ taskId, entries, onShowDiff, onShowProjectFiles }: {
  taskId: string;
  entries: readonly AgentEntry[];
  onShowDiff?: () => void;
  onShowProjectFiles?: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const { saved, documents, edits, checks } = useMemo(() => collectTurnResults(entries), [entries]);
  if (!saved.length && !documents.length && !edits.length && !checks.length) return null;

  return <section className="awTurnResults" aria-labelledby={titleId}>
    <h3 id={titleId}><FileCheck2 size={16} aria-hidden="true"/>{t('aw.turnResults.title', { defaultValue: 'Turn results' })}</h3>
    {!!saved.length && <div className="awTurnResultSaved">
      <span>{t('aw.turnResults.saved', { defaultValue: 'Saved copies' })}</span>
      <ul>{saved.map(file => <SavedCopy key={file.id} taskId={taskId} file={file}/>)}</ul>
    </div>}
    {!!documents.length && <ResultGroup label={t('aw.turnResults.documents', { defaultValue: 'Created documents' })} count={documents.length}>
      <ul>{documents.map(file => <li key={file.id}>
        {file.name} <span>{t('agent.artifacts.version', { defaultValue: 'v{{version}}', version: file.version })}</span>
      </li>)}</ul>
      {onShowProjectFiles && <Button type="button" onClick={onShowProjectFiles}>{t('projectFiles.title', { defaultValue: 'Project files' })}</Button>}
    </ResultGroup>}
    {!!edits.length && <ResultGroup label={t('aw.turnResults.edits', { defaultValue: 'File changes' })} count={edits.length}>
      <ul>{edits.map(([path, previews]) => <li key={path}>
        {previews.length ? <RecordedDiff path={path} previews={previews}/> : <code>{path}</code>}
      </li>)}</ul>
      {onShowDiff && <Button type="button" onClick={onShowDiff}>
        <GitBranch size={14} aria-hidden="true"/>{t('aw.turnResults.worktree', { defaultValue: 'Working tree changes' })}
      </Button>}
    </ResultGroup>}
    {!!checks.length && <ResultGroup label={t('aw.turnResults.checks', { defaultValue: 'Check commands' })} count={checks.length}>
      <ul>{checks.map(check => <li key={check.id} className="awTurnResultCheck">
        <code>{check.command}</code>
        <span className={check.exitCode === 0 ? undefined : 'awTurnResultError'}>
          {t('aw.turnResults.exitCode', { defaultValue: 'Exit code {{code}}', code: check.exitCode })}
        </span>
      </li>)}</ul>
    </ResultGroup>}
  </section>;
}
