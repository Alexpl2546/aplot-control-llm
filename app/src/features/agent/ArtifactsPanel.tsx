import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, ExternalLink, FileCheck2, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { listUserArtifacts, openUserArtifact, removeUserArtifact, saveUserArtifact, type UserArtifact } from '../../services/userArtifacts';
import './artifactsPanel.css';
import { ArtifactImagePreview } from './ArtifactImagePreview';

export function ArtifactsPanel({ taskId, defaultSourceRelative = '' }: { taskId: string; defaultSourceRelative?: string }) {
  const { t, i18n } = useTranslation();
  const [artifacts, setArtifacts] = useState<UserArtifact[]>([]), [path, setPath] = useState(defaultSourceRelative);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [busyId, setBusyId] = useState(''), [removeTarget, setRemoveTarget] = useState<UserArtifact>();
  const refresh = useCallback(async () => {
    if (!taskId) { setArtifacts([]); return; }
    setLoading(true); setError('');
    try { setArtifacts(await listUserArtifacts(taskId)); }
    catch { setError(t('agent.artifacts.loadFailed', { defaultValue: 'Could not load saved results.' })); }
    finally { setLoading(false); }
  }, [taskId, t]);
  useEffect(() => { setPath(defaultSourceRelative); }, [defaultSourceRelative]);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const source = path.trim();
    if (!source || source.startsWith('/') || source.startsWith('\\') || /^[a-z]:/i.test(source)) {
      setError(t('agent.artifacts.relativePathRequired', { defaultValue: 'Enter a file path relative to this project.' })); return;
    }
    setSaving(true); setError('');
    try {
      await saveUserArtifact(taskId, source);
      setPath('');
      await refresh();
    } catch (cause) {
      const code = String(cause).replace(/^Error: /, '');
      setError(t(`agent.artifacts.errors.${code}`, { defaultValue: t('agent.artifacts.saveFailed', { defaultValue: 'Could not save this result.' }) }));
    } finally { setSaving(false); }
  };
  const open = async (artifact: UserArtifact) => {
    setBusyId(artifact.id); setError('');
    try { await openUserArtifact(taskId, artifact.id); }
    catch { setError(t('agent.artifacts.openFailed', { defaultValue: 'Could not open the saved copy.' })); }
    finally { setBusyId(''); }
  };
  const remove = async () => {
    if (!removeTarget) return;
    setBusyId(removeTarget.id); setError('');
    try { await removeUserArtifact(taskId, removeTarget.id); setRemoveTarget(undefined); await refresh(); }
    catch { setError(t('agent.artifacts.removeFailed', { defaultValue: 'Could not remove the saved copy.' })); throw new Error(t('agent.artifacts.removeFailed', { defaultValue: 'Could not remove the saved copy.' })); }
    finally { setBusyId(''); }
  };
  const bytes = (value: number) => value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value / (1024 * 1024))} MB`;
  return <section className="agentArtifacts" aria-label={t('agent.artifacts.title', { defaultValue: 'Saved results' })}>
    <header className="agentArtifactsHeader"><div><h3><Archive size={17}/>{t('agent.artifacts.title', { defaultValue: 'Saved results' })}</h3><p>{t('agent.artifacts.description', { defaultValue: 'Save a separate copy of a project file. The original stays in the project.' })}</p></div>
      <button type="button" className="kIconBtn" aria-label={t('agent.artifacts.refresh', { defaultValue: 'Refresh saved results' })} title={t('agent.artifacts.refresh', { defaultValue: 'Refresh saved results' })} disabled={loading || saving} onClick={() => void refresh()}><RefreshCw size={14}/></button>
    </header>
    <form className="agentArtifactsSave" onSubmit={event => void save(event)}>
      <label htmlFor="agent-artifact-source">{t('agent.artifacts.sourcePath', { defaultValue: 'Project file path' })}</label>
      <div><input id="agent-artifact-source" type="text" value={path} placeholder={t('agent.artifacts.pathPlaceholder', { defaultValue: 'reports/final.docx' })} autoComplete="off" spellCheck={false} maxLength={1024} disabled={saving || !taskId} onChange={event => setPath(event.target.value)}/>
        <Button type="submit" className="primary" disabled={!taskId || !path.trim() || saving}>{saving ? <LoaderCircle size={14} className="isSpinning"/> : <FileCheck2 size={14}/>}<span>{t('agent.artifacts.saveResult', { defaultValue: 'Save result' })}</span></Button>
      </div>
      <small>{t('agent.artifacts.relativeHint', { defaultValue: 'Use a path relative to the task project. Aplot stores an independent copy.' })}</small>
    </form>
    {error && <p className="agentArtifactsError" role="alert">{error}</p>}
    {loading && <p className="agentArtifactsStatus" role="status">{t('agent.artifacts.loading', { defaultValue: 'Loading saved results…' })}</p>}
    {!loading && !artifacts.length && <p className="agentArtifactsEmpty">{t('agent.artifacts.empty', { defaultValue: 'No result copies saved for this task yet.' })}</p>}
    <div className="agentArtifactsList">{artifacts.map(artifact => <article className="agentArtifactCard" key={artifact.id}>
      <div className="agentArtifactTitle"><FileCheck2 size={16}/><div><b>{artifact.name}</b><small>{artifact.sourceRelative}</small></div><span>{t('agent.artifacts.version', { defaultValue: `v${artifact.version}`, version: artifact.version })}</span></div>
      <div className="agentArtifactMeta"><span>{artifact.mime}</span><span>{bytes(artifact.bytes)}</span><time dateTime={artifact.createdAt}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(artifact.createdAt))}</time></div>
      <code title={artifact.sha256}>SHA-256 · {artifact.sha256}</code>
      {artifact.mime.startsWith('image/') && <ArtifactImagePreview taskId={taskId} artifactId={artifact.id} name={artifact.name}/>}
      <div className="agentArtifactActions"><Button type="button" disabled={busyId === artifact.id} onClick={() => void open(artifact)}><ExternalLink size={14}/>{t('agent.artifacts.openCopy', { defaultValue: 'Open saved copy' })}</Button>
        <Button type="button" className="danger" disabled={busyId === artifact.id} aria-label={`${t('agent.artifacts.removeCopy', { defaultValue: 'Remove saved copy' })}: ${artifact.name}`} onClick={() => setRemoveTarget(artifact)}><Trash2 size={14}/>{t('agent.artifacts.removeCopy', { defaultValue: 'Remove copy' })}</Button></div>
    </article>)}</div>
    <ConfirmDialog open={!!removeTarget} title={t('agent.artifacts.removeTitle', { defaultValue: 'Remove saved copy?' })} text={t('agent.artifacts.removeText', { defaultValue: 'This removes the managed copy only. The project file will stay unchanged.' })} confirmLabel={t('agent.artifacts.removeCopy', { defaultValue: 'Remove copy' })} dangerous busy={!!busyId} onCancel={() => setRemoveTarget(undefined)} onConfirm={remove}/>
  </section>;
}
