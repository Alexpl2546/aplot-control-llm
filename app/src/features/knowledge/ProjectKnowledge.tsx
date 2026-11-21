import { BookOpen, FolderPlus, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { pickDirectory } from '../../services/dialog';
import { knowledgeBind, knowledgeImportProjectHistory, knowledgeStatus, type HistoryImportResult, type KnowledgeVaultStatus } from '../../services/knowledge';
import { flushWorkspace, setProjectKnowledge, setProjectKnowledgeWriteVault, useWorkspaceStore } from '../agent/workspace';
import { knowledgeErrorKey } from './knowledgeModel';
import './knowledge.css';

/** Knowledge vaults bound to one agent project, edited in the project settings. */
export function ProjectKnowledge({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const project = useWorkspaceStore(s => s.projects.find(p => p.id === projectId));
  const bound = project?.knowledge ?? [];
  const [vaults, setVaults] = useState<KnowledgeVaultStatus[]>([]);
  const [error, setError] = useState('');
  const [importingHistory, setImportingHistory] = useState(false);
  const [historyResult, setHistoryResult] = useState<HistoryImportResult>();
  const [historyError, setHistoryError] = useState('');
  useEffect(() => { let current = true; void knowledgeStatus().then(s => { if (current) setVaults(s.vaults); }).catch(() => {}); return () => { current = false; }; }, []);
  useEffect(() => { setHistoryResult(undefined); setHistoryError(''); }, [projectId, project?.knowledgeWriteVault]);
  const toggle = (id: string, on: boolean) => setProjectKnowledge(projectId, on ? [...bound, id] : bound.filter(item => item !== id));
  const connect = async () => {
    setError('');
    try {
      const path = await pickDirectory();
      if (!path) return;
      const vault = await knowledgeBind(path);
      setVaults((await knowledgeStatus()).vaults);
      const current = useWorkspaceStore.getState().projects.find(p => p.id === projectId);
      setProjectKnowledge(projectId, [...(current?.knowledge ?? []), vault.id]);
    } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };
  const importHistory = async () => {
    const intendedVaultId = project?.knowledgeWriteVault;
    if (importingHistory || !intendedVaultId || !bound.includes(intendedVaultId)) return;
    setHistoryError('');
    setHistoryResult(undefined);
    setImportingHistory(true);
    try {
      await flushWorkspace();
      const savedProject = useWorkspaceStore.getState().projects.find(item => item.id === projectId);
      if (useWorkspaceStore.getState().saveError || savedProject?.knowledgeWriteVault !== intendedVaultId
        || !savedProject?.knowledge?.includes(intendedVaultId)) throw new Error('workspace-save');
      setHistoryResult(await knowledgeImportProjectHistory(projectId));
    }
    catch (e) {
      const key = knowledgeErrorKey(e);
      setHistoryError(t(key === 'knowledge.error.generic' ? 'knowledge.history.failed' : key));
    }
    finally { setImportingHistory(false); }
  };
  const canImportHistory = !disabled && !!project?.knowledgeWriteVault && bound.includes(project.knowledgeWriteVault);
  return <fieldset className="knProjectField" disabled={disabled}>
    <legend><BookOpen size={14}/>{t('knowledge.projectTitle')}</legend>
    <p className="awMuted">{t('knowledge.projectHelp')}</p>
    {vaults.map(row => <label key={row.vault.id} className="awCheck"><input type="checkbox" checked={bound.includes(row.vault.id)} onChange={event => toggle(row.vault.id, event.target.checked)}/><span><b>{row.vault.name}</b> <small title={row.vault.path}>{row.vault.path}</small></span></label>)}
    {!vaults.length && <p className="awMuted">{t('knowledge.projectNone')}</p>}
    <Button type="button" onClick={() => void connect()}><FolderPlus size={14}/>{t('knowledge.connect')}</Button>
    {bound.length > 0 && <div className="knPublishSetting">
      <b>{t('knowledge.publish.label')}</b>
      <ChoiceSelect label={t('knowledge.publish.label')} disabled={disabled} value={project?.knowledgeWriteVault ?? ''} onChange={id => setProjectKnowledgeWriteVault(projectId, id)}
        options={[{ value: '', label: t('knowledge.publish.off') }, ...vaults.filter(row => bound.includes(row.vault.id))
          .map(({ vault }) => ({ value: vault.id, label: vault.name, description: vault.path }))]}/>
      <p className="awMuted">{t('knowledge.publish.help')}</p>
    </div>}
    {bound.length > 0 && <div className="knHistoryImport">
      <b>{t('knowledge.history.title')}</b>
      <p className="awMuted">{t('knowledge.history.help')}</p>
      <Button type="button" disabled={!canImportHistory || importingHistory} onClick={() => void importHistory()}><History size={14}/>{t(importingHistory ? 'knowledge.history.importing' : 'knowledge.history.import')}</Button>
      {historyResult && <p className="awMuted" role="status">{t('knowledge.history.result', {
        agentTasks: historyResult.agentTasks, plainChats: historyResult.plainChats, notes: historyResult.notes,
        skipped: historyResult.skipped, pendingNotes: historyResult.pendingNotes,
      })}</p>}
      {historyError && <p className="awError" role="alert">{historyError}</p>}
    </div>}
    {error && <p className="awError" role="alert">{error}</p>}
  </fieldset>;
}
