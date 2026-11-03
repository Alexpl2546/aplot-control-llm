import { forkHostTask } from '../../services/agentTasks';
import { createTask, editTask, flushWorkspace, useWorkspaceStore } from './workspace';
import { useAgentStore } from './store';

/** Forks the native Codex thread; the source conversation and files stay intact. */
export async function forkCodexTask(sourceTaskId: string): Promise<void> {
  const workspace = useWorkspaceStore.getState();
  const source = workspace.tasks.find(task => task.id === sourceTaskId);
  const thread = useAgentStore.getState().threads[sourceTaskId];
  if (!workspace.ready || workspace.saveError || !source || source.runtime !== 'codex' || source.archived || source.deletedAt || !thread?.id || thread.pending || thread.starting || !thread.nativeGeneration) throw new Error('fork-unavailable');
  const taskId = createTask(source.projectId, `${source.title} · fork`);
  editTask(taskId, {
    runtime: 'codex', parentTaskId: source.id, connectionId: source.connectionId,
    connectionProfileId: source.connectionProfileId, cloudModel: source.cloudModel, codexModel: source.codexModel,
    accessMode: source.accessMode, reasoning: source.reasoning, instructions: source.instructions,
    presetId: source.presetId, agentName: source.agentName,
  });
  try {
    await flushWorkspace();
    if (useWorkspaceStore.getState().saveError) throw new Error('project-save-failed');
    const result = await forkHostTask({ commandId: crypto.randomUUID(), sourceTaskId, taskId, expectedGeneration: thread.nativeGeneration });
    if (result.status !== 'accepted') throw new Error(result.status === 'unknown' || result.status === 'dispatching' ? 'fork-unconfirmed' : 'fork-failed');
  } catch (error) {
    // Preserve a failed/uncertain branch for inspection. A fresh command must not
    // silently retry a fork whose native outcome was not confirmed.
    useAgentStore.getState().update(taskId, state => ({ ...state, starting: false, error: 'fork-failed', ioError: String(error).slice(0, 700) }));
    throw error;
  }
}
