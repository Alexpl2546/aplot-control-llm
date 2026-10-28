import type { ActivityEvent } from "../activity/model";
import type { AgentThread } from "../agent/store";
import { taskStatus } from "../agent/workspace";
import { repeatedFailures, type AgentPreset, type AgentProject, type AgentTask } from "../agent/workspaceModel";

export type NetworkStatus = "running" | "waiting" | "blocked" | "completed" | "stopped" | "inactive" | "ready";
export type NetworkAgentKind = "primary" | "child";

export interface NetworkAgent {
  id: string;
  name?: string;
  runtime?: "hermes" | "codex" | "claude";
  /** Presentation colour (base agents carry their own). */
  color?: string;
  kind: NetworkAgentKind;
  status: NetworkStatus;
  taskIds: string[];
  projectIds: string[];
}

export interface NetworkTask {
  task: AgentTask;
  project: AgentProject;
  thread?: AgentThread;
  status: NetworkStatus;
  participants: string[];
  events: ActivityEvent[];
}

export interface NetworkProject {
  project: AgentProject;
  taskIds: string[];
  agentIds: string[];
}

export interface NetworkLink {
  id: string;
  agentIds: [string, string];
  taskIds: string[];
}

export interface AgentNetworkSnapshot {
  projects: NetworkProject[];
  tasks: NetworkTask[];
  agents: NetworkAgent[];
  links: NetworkLink[];
}

export interface AgentNetworkSource {
  projects: readonly AgentProject[];
  tasks: readonly AgentTask[];
  presets: readonly AgentPreset[];
  threads: Readonly<Record<string, AgentThread>>;
  events: readonly ActivityEvent[];
}

export interface AgentNetworkOptions {
  /** When set, only tasks bound to the selected server run are projected. */
  runId?: string;
}

function stateFor(task: AgentTask, thread: AgentThread | undefined, events: readonly ActivityEvent[]): NetworkStatus {
  if (!thread) return "ready";
  if (thread.requests.length > 0) return "waiting";
  if (thread.error || repeatedFailures(thread.entries)) return "blocked";
  if (thread.pending || thread.starting) return "running";
  const completion = events.filter(event => event.kind === "agent.completed").sort((a, b) => b.time - a.time)[0];
  if (completion?.data.outcome === "error") return "blocked";
  if (completion?.data.outcome === "success") return "completed";
  if (completion?.data.outcome === "interrupted") return "stopped";
  const status = taskStatus(thread);
  if (status === "completed") return "completed";
  if (status === "stopped") return "stopped";
  if (status === "waiting") return "waiting";
  if (status === "running" || status === "recording") return "running";
  if (status === "disconnected" && thread.entries.length) return "inactive";
  return task.archived ? "completed" : "ready";
}

function childState(status: string): NetworkStatus {
  const value = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/error|failed|blocked|denied/.test(value)) return "blocked";
  if (/wait|review|approval|input|clarif/.test(value)) return "waiting";
  if (/complete|success|done|finish/.test(value)) return "completed";
  if (/stop|cancel|interrupt/.test(value)) return "stopped";
  if (/run|work|active|busy|start/.test(value)) return "running";
  return "ready";
}

function presetFor(task: AgentTask, presets: readonly AgentPreset[]) {
  return task.presetId ? presets.find(preset => preset.id === task.presetId) : undefined;
}

function primaryAgentFor(task: AgentTask, thread: AgentThread | undefined, preset: AgentPreset | undefined) {
  const live=!!thread&&!thread.ended&&!!(thread.id||thread.pending||thread.starting||thread.requests.length);
  if(!preset&&!live)return undefined;
  const runtime = thread?.nativeRuntime ?? task.runtime ?? preset?.runtime ?? (thread?.hermesSessionId ? "hermes" : undefined);
  const name = preset?.name.trim() || task.agentName?.trim() || undefined;
  if (!runtime && !name) return undefined;
  const normalizedName = (name ?? runtime ?? "agent").trim().toLocaleLowerCase();
  const id = task.presetId ? `preset:${task.presetId}` : `role:${runtime ?? "custom"}:${normalizedName}`;
  return { id, name, runtime };
}

function pairKey(a: string, b: string): string {
  return [a, b].sort((left, right) => left.localeCompare(right)).join("::");
}

/**
 * Projects existing workspace records and runtime events into a read-only graph.
 * No collaboration edges are inferred from a shared project or server binding:
 * an edge exists only when two runtime participants were recorded on the same task.
 */
export function buildAgentNetwork(source: AgentNetworkSource, options: AgentNetworkOptions = {}): AgentNetworkSnapshot {
  const projectsById = new Map(source.projects.map(project => [project.id, project]));
  const projectTasks = new Map<string, string[]>();
  const taskRows: NetworkTask[] = [];
  const agentsById = new Map<string, NetworkAgent>();
  const linksByPair = new Map<string, NetworkLink>();
  const presets = source.presets;
  const tasks = source.tasks
    .filter(task => !task.deletedAt && !task.archived && projectsById.has(task.projectId))
    .filter(task => !options.runId || task.binding?.runId === options.runId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const ensureAgent = (input: Omit<NetworkAgent, "taskIds" | "projectIds">, task: AgentTask): NetworkAgent => {
    const current = agentsById.get(input.id);
    if (current) {
      if (!current.taskIds.includes(task.id)) current.taskIds.push(task.id);
      if (!current.projectIds.includes(task.projectId)) current.projectIds.push(task.projectId);
      const rank: Record<NetworkStatus, number> = { blocked: 6, waiting: 5, running: 4, ready: 3, stopped: 2, inactive: 1.5, completed: 1 };
      if (rank[input.status] > rank[current.status]) current.status = input.status;
      return current;
    }
    const agent: NetworkAgent = { ...input, taskIds: [task.id], projectIds: [task.projectId] };
    agentsById.set(agent.id, agent);
    return agent;
  };

  for (const task of tasks) {
    const project = projectsById.get(task.projectId)!;
    const thread = source.threads[task.id];
    const taskEvents = source.events.filter(event => event.taskId === task.id).sort((a, b) => b.time - a.time);
    const status = stateFor(task, thread, taskEvents);
    const preset = presetFor(task, presets);
    const primary = primaryAgentFor(task, thread, preset);
    const participants: string[] = [];

    if (primary) {
      ensureAgent({ ...primary, kind: "primary", status }, task);
      participants.push(primary.id);
    }

    for (const collaboratorId of task.collaboratorPresetIds ?? []) {
      const collaborator = presets.find(preset => preset.id === collaboratorId);
      if (!collaborator) continue;
      const id = `preset:${collaborator.id}`;
      ensureAgent({ id, name: collaborator.name, runtime: collaborator.runtime, kind: "primary", status:"ready" }, task);
      if (!participants.includes(id)) participants.push(id);
    }

    for (const child of primary ? thread?.children ?? [] : []) {
      const id = `child:${task.id}:${child.id}`;
      ensureAgent({ id, name: child.name, kind: "child", status: childState(child.status) }, task);
      participants.push(id);
    }

    const row: NetworkTask = {
      task,
      project,
      thread,
      status,
      participants,
      events: taskEvents,
    };
    taskRows.push(row);
    const ids = projectTasks.get(project.id) ?? [];
    ids.push(task.id);
    projectTasks.set(project.id, ids);

    // Shared work is evidence-backed by the participant list from this task's runtime session.
    for (let left = 0; left < participants.length; left++) {
      for (let right = left + 1; right < participants.length; right++) {
        const [agentA, agentB] = [participants[left]!, participants[right]!].sort((a, b) => a.localeCompare(b));
        const key = pairKey(agentA, agentB);
        const link = linksByPair.get(key) ?? { id: key, agentIds: [agentA, agentB], taskIds: [] };
        if (!link.taskIds.includes(task.id)) link.taskIds.push(task.id);
        linksByPair.set(key, link);
      }
    }
  }

  const taskProjectIds = new Set(taskRows.map(row => row.project.id));
  for (const preset of presets) {
    const id = `preset:${preset.id}`;
    const assignedProjects = (preset.projectIds ?? []).filter(projectId => projectsById.has(projectId) && (!options.runId || taskProjectIds.has(projectId)));
    const current = agentsById.get(id);
    if (!current) {
      if (options.runId) continue;
      agentsById.set(id, { id, name:preset.name, runtime:preset.runtime, color:preset.color, kind:"primary", status:"ready", taskIds:[], projectIds:[...new Set(assignedProjects)] });
    } else {
      if (preset.color && !current.color) current.color = preset.color;
      for (const projectId of assignedProjects) if (!current.projectIds.includes(projectId)) current.projectIds.push(projectId);
    }
  }

  const projects = source.projects
    .filter(project => !options.runId || (projectTasks.get(project.id)?.length ?? 0) > 0)
    .map(project => ({ project, taskIds: projectTasks.get(project.id) ?? [], agentIds:[...agentsById.values()].filter(agent=>agent.projectIds.includes(project.id)).map(agent=>agent.id) }))
    .sort((a, b) => a.project.name.localeCompare(b.project.name));

  return {
    projects,
    tasks: taskRows,
    agents: [...agentsById.values()].sort((a, b) => (a.name ?? a.runtime ?? "").localeCompare(b.name ?? b.runtime ?? "")),
    links: [...linksByPair.values()].map(link => ({ ...link, taskIds: link.taskIds.sort((a, b) => a.localeCompare(b)) })),
  };
}

export function networkStatusForTask(snapshot: AgentNetworkSnapshot, taskId: string): NetworkStatus | undefined {
  return snapshot.tasks.find(row => row.task.id === taskId)?.status;
}
