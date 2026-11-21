import { Files, GitCompareArrows, Package, Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GitPanel } from './GitPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { McpConnectionsPanel } from './McpConnectionsPanel';
import { ProjectFilesPanel } from '../files/ProjectFilesPanel';
import { WorkspaceDialog } from './WorkspacePanels';

const sections = [
  { id: 'git', label: 'aw.diff', icon: GitCompareArrows },
  { id: 'artifacts', label: 'agent.artifacts.title', icon: Package },
  { id: 'files', label: 'projectFiles.title', icon: Files },
  { id: 'mcp', label: 'agent.mcp.title', icon: Plug },
] as const;

export type TaskProjectPanel = typeof sections[number]['id'];

export function TaskProjectTools({ taskId, projectId, codex, panel, onSelect, onClose }: {
  taskId: string;
  projectId?: string;
  codex: boolean;
  panel: TaskProjectPanel;
  onSelect: (panel: TaskProjectPanel) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const visible = sections.filter(({ id }) => id === 'git' || id === 'artifacts' || (projectId && (id === 'files' || codex)));
  return <WorkspaceDialog wide title={t('aw.taskTools')} onClose={onClose}>
    <div className="awSegment awProjectToolsTabs" role="group" aria-label={t('aw.taskTools')}>
      {visible.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={panel === id} onClick={() => onSelect(id)}>
        <Icon size={15} aria-hidden="true"/>{t(label)}
      </button>)}
    </div>
    {panel === 'git' && <GitPanel taskId={taskId}/>}
    {panel === 'artifacts' && <ArtifactsPanel taskId={taskId}/>}
    {panel === 'files' && projectId && <ProjectFilesPanel projectId={projectId}/>}
    {panel === 'mcp' && projectId && codex && <McpConnectionsPanel projectId={projectId}/>}
  </WorkspaceDialog>;
}
