import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitPanel } from './GitPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { McpConnectionsPanel } from './McpConnectionsPanel';
import { ProjectFilesPanel } from '../files/ProjectFilesPanel';
import './taskProjectTools.css';

export function TaskProjectTools({ taskId, projectId, codex }: { taskId: string; projectId?: string; codex?: boolean }) {
  const { t } = useTranslation();
  const [gitOpen, setGitOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  return <div className="awProjectTools"><details onToggle={event => setGitOpen(event.currentTarget.open)}>
    <summary>Git · {t('aw.diff')}</summary>
    {gitOpen && <GitPanel taskId={taskId}/>}
  </details><details onToggle={event => setArtifactsOpen(event.currentTarget.open)}>
    <summary>{t('agent.artifacts.title', { defaultValue: 'Saved results' })}</summary>
    {artifactsOpen && <ArtifactsPanel taskId={taskId}/>}
  </details>{projectId && <details onToggle={event => setFilesOpen(event.currentTarget.open)}>
    <summary>{t('projectFiles.title', { defaultValue: 'Project files' })}</summary>
    {filesOpen && <ProjectFilesPanel key={projectId} projectId={projectId}/>}
  </details>}{codex && projectId && <details onToggle={event => setMcpOpen(event.currentTarget.open)}>
    <summary>{t('agent.mcp.title', { defaultValue: 'External MCP servers' })}</summary>
    {mcpOpen && <McpConnectionsPanel projectId={projectId}/>}
  </details>}</div>;
}
