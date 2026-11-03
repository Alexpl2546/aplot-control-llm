import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitPanel } from './GitPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { McpConnectionsPanel } from './McpConnectionsPanel';
import { ProjectFilesPanel } from '../files/ProjectFilesPanel';
import './taskProjectTools.css';

export interface TaskProjectPanelRequest { panel: 'git' | 'files'; requestId: number }

export function TaskProjectTools({ taskId, projectId, codex, requestedPanel }: {
  taskId: string;
  projectId?: string;
  codex?: boolean;
  requestedPanel?: TaskProjectPanelRequest;
}) {
  const { t } = useTranslation();
  const [gitOpen, setGitOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const gitPanel = useRef<HTMLDetailsElement>(null);
  const filesPanel = useRef<HTMLDetailsElement>(null);
  const panel = requestedPanel?.panel;
  const requestId = requestedPanel?.requestId;

  useEffect(() => {
    if (requestId === undefined) return;
    const details = panel === 'git' ? gitPanel.current : filesPanel.current;
    if (!details) return;
    details.open = true;
    const summary = details.querySelector('summary');
    summary?.focus({ preventScroll: true });
    summary?.scrollIntoView?.({ block: 'nearest' });
  }, [panel, requestId]);

  return <div className="awProjectTools"><details ref={gitPanel} onToggle={event => setGitOpen(event.currentTarget.open)}>
    <summary>Git · {t('aw.diff')}</summary>
    {gitOpen && <GitPanel taskId={taskId}/>}
  </details><details onToggle={event => setArtifactsOpen(event.currentTarget.open)}>
    <summary>{t('agent.artifacts.title', { defaultValue: 'Saved results' })}</summary>
    {artifactsOpen && <ArtifactsPanel taskId={taskId}/>}
  </details>{projectId && <details ref={filesPanel} onToggle={event => setFilesOpen(event.currentTarget.open)}>
    <summary>{t('projectFiles.title', { defaultValue: 'Project files' })}</summary>
    {filesOpen && <ProjectFilesPanel key={projectId} projectId={projectId}/>}
  </details>}{codex && projectId && <details onToggle={event => setMcpOpen(event.currentTarget.open)}>
    <summary>{t('agent.mcp.title', { defaultValue: 'External MCP servers' })}</summary>
    {mcpOpen && <McpConnectionsPanel projectId={projectId}/>}
  </details>}</div>;
}
