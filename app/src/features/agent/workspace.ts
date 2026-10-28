import { cloudSelection,useOpenAi } from '../openai/store';
import { create } from 'zustand';
import { loadWorkspace, saveWorkspace, validateWorkspaceFolder } from '../../services/agentWorkspace';
import { EMPTY_AGENT, useAgentStore, type AgentThread } from './store';
import { adoptHostSnapshot, followHostTasks, hostOwns, loadHostTasks } from './hostTasks';
import { clientFields } from './taskProjection';
import { resetHostTask } from '../../services/agentTasks';
import { toolOutcome, type AgentProject, type AgentTask, type ProjectMemory, type AgentBinding,type AgentPreset } from './workspaceModel';

interface WorkspaceState {
  presets:AgentPreset[]; projects: AgentProject[]; tasks: AgentTask[]; memory: ProjectMemory[];
  selectedProjectId: string; selectedTaskId: string; visibleTaskId: string;
  ready: boolean; error: string; saveError: string;
  /** Base templates were added as agents once; never re-added after the person deletes them. */
  templatesSeeded: boolean;
}
export const useWorkspaceStore = create<WorkspaceState>(() => ({ presets:[], projects: [], tasks: [], memory: [], selectedProjectId: '', selectedTaskId: '', visibleTaskId: '', ready: false, error: '', saveError: '', templatesSeeded: false }));
let revision = 0, initialization: Promise<void> | undefined, dirty = false, writing: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
export function restoredThread(raw: Partial<AgentThread>): AgentThread {
  return { ...EMPTY_AGENT, ...raw, id: undefined, pending: false, starting: false, cursor: undefined, requests: [], voiceStatus:'idle', voiceStartedAt:undefined, voiceDiscard:false, voiceSendAfter:false, ioError:undefined, ended: !!raw.entries?.length&&!raw.nativeSessionId, restored: !!raw.entries?.length, stopped: false, error: '',
    entries: (raw.entries ?? []).map(e => e.kind === 'tool' ? { ...e, status: e.status === 'running' ? 'unknown' : toolOutcome(e.result ?? e.text) } : e) };
}
export function workspaceSnapshot(): Record<string, unknown> {
  const s = useWorkspaceStore.getState();
  // Conversations of host tasks live in the host database; only the window's own fields are saved here.
  const owned = new Set(s.tasks.filter(task => hostOwns(task.runtime)).map(task => task.id));
  const threads = Object.fromEntries(Object.entries(useAgentStore.getState().threads).map(([id, thread]) => [id, owned.has(id) ? clientFields(thread) : thread]));
  return { agentDirectoryVersion:1, templatesSeeded: s.templatesSeeded ? 1 : 0, presets:s.presets, projects: s.projects, tasks: s.tasks, memory: s.memory, selectedProjectId: s.selectedProjectId, selectedTaskId: s.selectedTaskId, threads, mode: useAgentStore.getState().mode };
}
export async function flushWorkspace(): Promise<void> {
  if (timer) clearTimeout(timer); timer = undefined;
  if (writing) { await writing; if (dirty) return flushWorkspace(); return; }
  if (!dirty || !useWorkspaceStore.getState().ready) return;
  dirty = false;
  const snapshot = workspaceSnapshot();
  writing = (async () => {
    try { revision = await saveWorkspace(snapshot, revision); useWorkspaceStore.setState({ saveError: '' }); }
    catch (e) { dirty = true; useWorkspaceStore.setState({ saveError: String(e).includes('workspace-conflict') ? 'conflict' : 'save' }); }
  })();
  await writing; writing = undefined;
  if (dirty && !useWorkspaceStore.getState().saveError) await flushWorkspace();
}
function schedule() {
  if (!useWorkspaceStore.getState().ready) return;
  dirty = true;
  if (!timer) timer = setTimeout(() => { timer = undefined; void flushWorkspace(); }, 500);
}
export function initializeWorkspace(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const saved = await loadWorkspace();
      if (saved && saved.version !== 2) throw new Error('workspace-version');
      const data = saved?.data ?? {};
      if (saved && (!Array.isArray(data.projects) || !Array.isArray(data.tasks) || !Array.isArray(data.memory) || !data.threads || typeof data.threads !== 'object')) throw new Error('workspace-invalid');
      revision = saved?.revision ?? 0;
      const projects = (data.projects ?? []) as AgentProject[], tasks = (data.tasks ?? []) as AgentTask[];
      const presets = (Array.isArray(data.presets) ? data.presets : []) as AgentPreset[];
      const migrateNamedAgents = data.agentDirectoryVersion !== 1;
      const migrateOrphanEmployees = migrateNamedAgents && presets.length === 0;
      const presetKeys = new Map(presets.map(preset => [`${preset.runtime}:${preset.connectionProfileId ?? ''}:${preset.name.trim().toLocaleLowerCase()}`, preset]));
      const presetIds = new Set(presets.map(preset => preset.id));
      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index]!;
        if (task.deletedAt || task.archived) continue;
        const missingLinkedPreset = !!task.presetId && !presetIds.has(task.presetId);
        const namedLegacyAgent = migrateNamedAgents && !task.presetId && (!!task.agentName?.trim() || migrateOrphanEmployees);
        if (!missingLinkedPreset && !namedLegacyAgent) continue;
        const name = (task.agentName?.trim() || task.title.trim()).slice(0,80);
        if (!name) continue;
        const runtime = task.runtime ?? 'hermes';
        const key = `${runtime}:${task.connectionProfileId ?? ''}:${name.toLocaleLowerCase()}`;
        let preset = missingLinkedPreset ? undefined : presetKeys.get(key);
        if (!preset) {
          preset = {
            id: missingLinkedPreset ? task.presetId! : `restored-agent:${task.id}`,
            name,
            runtime,
            connectionProfileId: task.connectionProfileId,
            model: task.cloudModel ?? task.codexModel,
            binding: task.binding ? structuredClone(task.binding) : undefined,
            accessMode: task.accessMode ?? 'manual',
            instructions: (task.instructions ?? '').slice(0,16000),
            autoStartServer: task.autoStartServer,
          };
          presets.push(preset);
          presetKeys.set(key, preset);
          presetIds.add(preset.id);
        }
        tasks[index] = { ...task, presetId:preset.id, agentName:name };
      }
      const host = await loadHostTasks();
      let threads = Object.fromEntries(Object.entries((data.threads ?? {}) as Record<string, AgentThread>).map(([id,s]) => [id, restoredThread(s)]));
      if (host) threads = adoptHostSnapshot(host, threads, tasks);
      // Adopt V1 renderer conversations without moving live callback ownership.
      for (const [key, thread] of Object.entries(useAgentStore.getState().threads)) {
        if (thread.cwd && !tasks.some(t => t.id === key) && (thread.entries.length || thread.pending)) {
          let p = projects.find(p => p.path.toLowerCase() === thread.cwd.toLowerCase());
          if (!p) { p = { id: crypto.randomUUID(), path: thread.cwd, name: thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? thread.cwd, skills: thread.skills, createdAt: Date.now() }; projects.push(p); }
          tasks.push({ id: key, projectId: p.id, title: thread.entries.find(e => e.kind === 'user')?.text.slice(0,80) ?? 'Hermes', createdAt: Date.now(), updatedAt: Date.now(), unread: false, archived: false });
        }
        threads[key] = thread;
      }
      useAgentStore.setState({ threads, mode: data.mode === 'agent' ? 'agent' : useAgentStore.getState().mode });
      useWorkspaceStore.setState({ presets, projects, tasks, memory: (data.memory ?? []) as ProjectMemory[], selectedProjectId: String(data.selectedProjectId ?? projects[0]?.id ?? ''), selectedTaskId: String(data.selectedTaskId ?? tasks[0]?.id ?? ''), templatesSeeded: data.templatesSeeded === 1, ready: true });
      useWorkspaceStore.subscribe((state, previous) => {
        if (state.presets!==previous.presets || state.templatesSeeded!==previous.templatesSeeded || state.projects !== previous.projects || state.tasks !== previous.tasks || state.memory !== previous.memory || state.selectedProjectId !== previous.selectedProjectId || state.selectedTaskId !== previous.selectedTaskId) schedule();
      });
      useAgentStore.subscribe((state, previous) => {
        if (state.threads === previous.threads && state.mode === previous.mode) return;
        const ws = useWorkspaceStore.getState();
        let changed = false;
        const updated = ws.tasks.map(task => {
          const current = state.threads[task.id], old = previous.threads[task.id];
          if (current && current !== old && (current.entries !== old?.entries || current.requests !== old?.requests)) {
            changed = true;
            return { ...task, updatedAt: Date.now(), unread: task.unread || (ws.visibleTaskId !== task.id && ((old?.pending && !current.pending) || current.requests.length > (old?.requests.length ?? 0))) };
          }
          return task;
        });
        if (changed) useWorkspaceStore.setState({ tasks: updated });
        schedule();
      });
      schedule();
      if (host) void followHostTasks();
    } catch (error) { useWorkspaceStore.setState({ error: String(error).includes('version') ? 'version' : 'load', ready: false }); initialization = undefined; }
  })();
  return initialization;
}
export async function openProject(path: string): Promise<string> {
  const canonical = await validateWorkspaceFolder(path);
  const pathKey = (value: string) => value.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'').replace(/\//g,'\\').toLowerCase();
  const existing = useWorkspaceStore.getState().projects.find(p => pathKey(p.path) === pathKey(canonical));
  if (existing) { selectProject(existing.id); return existing.id; }
  const id = crypto.randomUUID();
  const project: AgentProject = { id, path: canonical, name: canonical.split(/[\\/]/).filter(Boolean).at(-1) ?? canonical, skills: '', createdAt: Date.now() };
  useWorkspaceStore.setState(s => ({ projects: [...s.projects, project], selectedProjectId: id, selectedTaskId: '' }));
  await flushWorkspace(); return id;
}
export function selectProject(id: string) {
  const s = useWorkspaceStore.getState();
  useWorkspaceStore.setState({ selectedProjectId: id, selectedTaskId: s.tasks.find(t => t.projectId === id && !t.archived && !t.deletedAt)?.id ?? '' });
}
export function selectTask(id: string) {
  const task = useWorkspaceStore.getState().tasks.find(t => t.id === id); if (!task) return;
  useWorkspaceStore.setState(s => ({ selectedProjectId: task.projectId, selectedTaskId: id, tasks: s.tasks.map(t => t.id === id ? { ...t, unread: false } : t) }));
}
export function createTask(projectId: string, title: string, binding?: AgentBinding): string {
  const p = useWorkspaceStore.getState().projects.find(p => p.id === projectId); if (!p) throw new Error('project-missing');
  const id = crypto.randomUUID(), now = Date.now();
  useAgentStore.getState().update(id, () => ({ ...EMPTY_AGENT, cwd: p.path, skills: p.skills }));
  useWorkspaceStore.setState(s => ({ tasks: [...s.tasks, { id, projectId, title: title.trim().slice(0,120) || 'Hermes', binding, archived: false, unread: false, createdAt: now, updatedAt: now }], selectedTaskId: id, selectedProjectId: projectId }));
  return id;
}
export function editTask(id: string, patch: Partial<Pick<AgentTask,'title'|'archived'|'binding'|'accessMode'|'runtime'|'codexModel'|'cloudModel'|'connectionId'|'connectionProfileId'|'instructions'|'presetId'|'collaboratorPresetIds'|'agentName'|'autoStartServer'>>) {
  useWorkspaceStore.setState(s => ({ tasks: s.tasks.map(t => t.id === id ? { ...t, ...patch, title: patch.title?.trim().slice(0,120) || t.title } : t) }));
}
export function renameProject(id: string, name: string) {
  const title = name.trim().slice(0,120);
  if (title) useWorkspaceStore.setState(s => ({ projects: s.projects.map(p => p.id === id ? { ...p, name: title } : p) }));
}
export async function updateProjectSettings(id:string,name:string,path:string):Promise<void> {
  const previous=useWorkspaceStore.getState().projects.find(project=>project.id===id);
  if(!previous)throw new Error('project-missing');
  const changed=path.trim()!==previous.path;
  if(changed&&projectHasActiveSessions(id))throw new Error('project-busy');
  const canonical=changed?await validateWorkspaceFolder(path.trim()):previous.path;
  // Folder validation is asynchronous; recheck ownership before changing state.
  if(changed&&projectHasActiveSessions(id))throw new Error('project-busy');
  const key=(value:string)=>value.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'').replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase();
  if(useWorkspaceStore.getState().projects.some(project=>project.id!==id&&key(project.path)===key(canonical)))throw new Error('project-folder-used');
  useWorkspaceStore.setState(state=>({projects:state.projects.map(project=>project.id===id?{...project,name:name.trim().slice(0,120)||project.name,path:canonical}:project)}));
  if(changed){
    const projectTasks=useWorkspaceStore.getState().tasks.filter(task=>task.projectId===id);
    // Host sessions are bound to the old folder: forget them on the host too.
    for(const task of projectTasks)if(hostOwns(task.runtime))await resetHostTask(task.id).catch(()=>undefined);
    const taskIds=new Set(projectTasks.map(task=>task.id));
    useAgentStore.setState(state=>({threads:Object.fromEntries(Object.entries(state.threads).map(([taskId,thread])=>[taskId,taskIds.has(taskId)?{...thread,cwd:canonical,id:undefined,nativeSessionId:undefined,nativeRuntime:undefined,nativeConnectionId:undefined,hermesSessionId:undefined,cursor:undefined,context:undefined,attachments:[],queue:[],ended:!!thread.entries.length,restored:!!thread.entries.length}:thread]))}));
  }
  schedule();await flushWorkspace();
  if(useWorkspaceStore.getState().saveError)throw new Error('project-save-failed');
}
export function projectHasActiveSessions(id: string): boolean {
  const threads=useAgentStore.getState().threads;
  return useWorkspaceStore.getState().tasks.some(task=>{
    if(task.projectId!==id)return false;
    const thread=threads[task.id];
    return !!thread&&(!!thread.pending||!!thread.starting||!!thread.id&&!thread.ended||thread.requests.length>0||!!thread.voiceStatus&&thread.voiceStatus!=='idle');
  });
}
/** Remove application records only. Never open, validate or delete the project folder. */
export async function removeProject(id: string): Promise<void> {
  if(projectHasActiveSessions(id))throw new Error('project-busy');
  const state=useWorkspaceStore.getState();
  const taskIds=new Set(state.tasks.filter(task=>task.projectId===id).map(task=>task.id));
  const projects=state.projects.filter(project=>project.id!==id);
  const tasks=state.tasks.filter(task=>!taskIds.has(task.id));
  const selectedProjectId=state.selectedProjectId===id?projects[0]?.id??'':state.selectedProjectId;
  const selectedTaskId=taskIds.has(state.selectedTaskId)||state.selectedProjectId===id
    ?tasks.find(task=>task.projectId===selectedProjectId&&!task.archived&&!task.deletedAt)?.id??'':state.selectedTaskId;
  useWorkspaceStore.setState({projects,tasks,selectedProjectId,selectedTaskId,
    visibleTaskId:taskIds.has(state.visibleTaskId)?'':state.visibleTaskId,
    memory:state.memory.filter(record=>record.projectId!==id),
    presets:state.presets.map(preset=>preset.projectIds?.includes(id)?{...preset,projectIds:preset.projectIds.filter(projectId=>projectId!==id)}:preset)});
  useAgentStore.setState(current=>({threads:Object.fromEntries(Object.entries(current.threads).filter(([taskId])=>!taskIds.has(taskId)))}));
  await flushWorkspace();
  if(useWorkspaceStore.getState().saveError)throw new Error('project-save-failed');
}
/** Reversible removal. Files, confirmed project memory and private Hermes home stay intact. */
export async function trashTask(id: string, closeSession: (taskId: string) => Promise<boolean>) {
  const task = useWorkspaceStore.getState().tasks.find(t => t.id === id);
  if (!task || task.deletedAt) return;
  const worker = useAgentStore.getState().threads[id]?.id;
  if (worker && !await closeSession(id)) throw new Error('task-close-failed');
  const currentWorker = useAgentStore.getState().threads[id]?.id;
  if (currentWorker && currentWorker !== worker) throw new Error('task-session-changed');
  useAgentStore.getState().update(id,s=>({...s,id:undefined,ended:true,pending:false,starting:false,requests:[],voiceStatus:'idle'}));
  useWorkspaceStore.setState(s=>({tasks:s.tasks.map(t=>t.id===id?{...t,deletedAt:Date.now(),unread:false}:t),
    selectedTaskId:s.selectedTaskId===id?s.tasks.find(t=>t.id!==id&&t.projectId===task.projectId&&!t.archived&&!t.deletedAt)?.id??'':s.selectedTaskId}));
  await flushWorkspace();
}
export function restoreTask(id: string) {
  useWorkspaceStore.setState(s=>({tasks:s.tasks.map(t=>t.id===id?{...t,deletedAt:undefined,archived:false}:t)}));
}
export function saveMemory(record: ProjectMemory) {
  useWorkspaceStore.setState(s => ({ memory: [...s.memory.filter(m => m.id !== record.id), { ...record, text: record.text.trim().slice(0,12000), updatedAt: Date.now() }] }));
}
export function deleteMemory(id: string) { useWorkspaceStore.setState(s => ({ memory: s.memory.filter(m => m.id !== id) })); }
export function taskStatus(thread?: AgentThread) {
  if (!thread) return 'ready';
  if (thread.requests.length) return 'waiting';
  if (thread.voiceStatus && thread.voiceStatus !== 'idle') return 'recording';
  if (thread.pending) return 'running';
  if (thread.restored || thread.ended) return 'disconnected';
  if (thread.error) return 'attention';
  if (thread.stopped) return 'stopped';
  return thread.entries.some(e => e.kind === 'assistant' && e.text) ? 'completed' : 'ready';
}

export function saveAgentPreset(preset:AgentPreset){
  const previous=useWorkspaceStore.getState().presets.find(item=>item.id===preset.id);
  if(!preset.name.trim()||preset.name.length>80||preset.name.trim().length>20&&preset.name.trim()!==previous?.name.trim()||preset.instructions.length>16000)throw new Error('preset-limit');
  useWorkspaceStore.setState(s=>({presets:s.presets.some(p=>p.id===preset.id)?s.presets.map(p=>p.id===preset.id?{...preset,name:preset.name.trim()}:p):[...s.presets,{...preset,name:preset.name.trim()}],tasks:s.tasks.map(task=>task.presetId===preset.id?{...task,agentName:preset.name.trim()}:task)}));
}
export function deleteAgentPreset(id:string){useWorkspaceStore.setState(s=>({presets:s.presets.filter(p=>p.id!==id),tasks:s.tasks.map(task=>({ ...task, presetId:task.presetId===id?undefined:task.presetId, collaboratorPresetIds:task.collaboratorPresetIds?.filter(presetId=>presetId!==id) }))}));}

export function setAgentProjectAssignment(presetId:string,projectId:string,assigned:boolean){
  const state=useWorkspaceStore.getState();if(!state.projects.some(project=>project.id===projectId))return;
  useWorkspaceStore.setState(s=>({presets:s.presets.map(preset=>preset.id===presetId?{...preset,projectIds:[...new Set([...(preset.projectIds??[]).filter(id=>id!==projectId),...(assigned?[projectId]:[])])]}:preset)}));
}

export function recruitAgentToTask(taskId:string,presetId:string,recruited:boolean){
  const state=useWorkspaceStore.getState(),preset=state.presets.find(item=>item.id===presetId),task=state.tasks.find(item=>item.id===taskId&&!item.archived&&!item.deletedAt);
  if(!preset||!task||task.presetId===presetId)return;
  const ids=new Set(task.collaboratorPresetIds??[]);if(recruited)ids.add(presetId);else ids.delete(presetId);
  editTask(taskId,{collaboratorPresetIds:ids.size?[...ids]:undefined});
}

export function assignAgentPreset(taskId:string,presetId:string){
  const thread=useAgentStore.getState().threads[taskId];if(thread?.id||thread?.pending||thread?.entries.length)throw new Error('session-pinned');
  if(!presetId){editTask(taskId,{presetId:undefined,agentName:undefined});return;}
  const preset=useWorkspaceStore.getState().presets.find(p=>p.id===presetId);if(!preset)throw new Error('preset-missing');
  const selection=preset.runtime==='hermes'?undefined:cloudSelection(useOpenAi.getState(),preset.runtime==='claude'?'claude':'openai',undefined,preset.connectionProfileId);
  editTask(taskId,{presetId:preset.id,agentName:preset.name,runtime:preset.runtime,cloudModel:preset.model,connectionProfileId:preset.connectionProfileId,connectionId:selection?.status.connectionId,binding:preset.binding?structuredClone(preset.binding):undefined,accessMode:preset.accessMode,instructions:preset.instructions,autoStartServer:preset.autoStartServer});
}
