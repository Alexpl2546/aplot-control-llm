import { BookOpen, FolderPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Primitives';
import { pickDirectory } from '../../services/dialog';
import { knowledgeBind, knowledgeStatus, type KnowledgeVaultStatus } from '../../services/knowledge';
import { setProjectKnowledge, useWorkspaceStore } from '../agent/workspace';
import { knowledgeErrorKey } from './knowledgeModel';
import './knowledge.css';

/** Knowledge vaults bound to one agent project, edited in the project settings. */
export function ProjectKnowledge({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const bound = useWorkspaceStore(s => s.projects.find(p => p.id === projectId)?.knowledge) ?? [];
  const [vaults, setVaults] = useState<KnowledgeVaultStatus[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { let current = true; void knowledgeStatus().then(s => { if (current) setVaults(s.vaults); }).catch(() => {}); return () => { current = false; }; }, []);
  const toggle = (id: string, on: boolean) => setProjectKnowledge(projectId, on ? [...bound, id] : bound.filter(item => item !== id));
  const connect = async () => {
    setError('');
    try {
      const path = await pickDirectory();
      if (!path) return;
      const vault = await knowledgeBind(path);
      setVaults((await knowledgeStatus()).vaults);
      setProjectKnowledge(projectId, [...bound, vault.id]);
    } catch (e) { setError(t(knowledgeErrorKey(e))); }
  };
  return <fieldset className="knProjectField" disabled={disabled}>
    <legend><BookOpen size={14}/>{t('knowledge.projectTitle')}</legend>
    <p className="awMuted">{t('knowledge.projectHelp')}</p>
    {vaults.map(row => <label key={row.vault.id} className="awCheck"><input type="checkbox" checked={bound.includes(row.vault.id)} onChange={event => toggle(row.vault.id, event.target.checked)}/><span><b>{row.vault.name}</b> <small title={row.vault.path}>{row.vault.path}</small></span></label>)}
    {!vaults.length && <p className="awMuted">{t('knowledge.projectNone')}</p>}
    <Button type="button" onClick={() => void connect()}><FolderPlus size={14}/>{t('knowledge.connect')}</Button>
    {error && <p className="awError" role="alert">{error}</p>}
  </fieldset>;
}
