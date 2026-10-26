import type { AgentThread } from './store';
import type { AgentPreset, AgentTask } from './workspaceModel';
import { agentName } from './AgentIdentity';

export interface SidebarAgent {
  id: string;
  name: string;
  runtime: AgentPreset['runtime'];
  preset?: AgentPreset;
  tasks: AgentTask[];
}

function hasLiveSession(task: AgentTask, threads: Record<string, AgentThread>) {
  const thread = threads[task.id];
  return Boolean(thread && !thread.ended && (thread.id || thread.pending || thread.starting));
}

/** Show saved agents, their live tasks, and live tasks whose saved agent was removed. */
export function sidebarAgents(presets: AgentPreset[], tasks: AgentTask[], threads: Record<string, AgentThread>): SidebarAgent[] {
  const visibleTasks = tasks.filter(task => !task.deletedAt && !task.archived && hasLiveSession(task, threads)).sort((a, b) => {
    const priority = (task: AgentTask) => {
      const thread = threads[task.id];
      return thread?.requests.length ? 3 : thread?.pending || thread?.starting ? 2 : thread?.id && !thread.ended ? 1 : 0;
    };
    return priority(b) - priority(a) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  });
  const agents = presets.map(preset => ({
    id:`preset:${preset.id}`,
    name:preset.name,
    runtime:preset.runtime,
    preset,
    tasks:visibleTasks.filter(task=>task.presetId===preset.id||task.collaboratorPresetIds?.includes(preset.id)),
  }));
  const assignedTaskIds = new Set(agents.flatMap(agent => agent.tasks.map(task => task.id)));
  const orphanSessions = visibleTasks.filter(task => !assignedTaskIds.has(task.id)).map(task => ({
    id: `task:${task.id}`,
    name: task.agentName?.trim() || task.title,
    runtime: task.runtime ?? 'hermes',
    tasks: [task],
  }));
  return [...agents, ...orphanSessions];
}
