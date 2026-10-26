import { Bot, Plus } from 'lucide-react';
import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Primitives';
import { AgentIcon, agentName } from '../../features/agent/AgentIdentity';
import { AgentActionsMenu, type AgentMenuTarget } from '../../features/agent/AgentActionsMenu';
import { openAgentPreset, openAgentPresets } from '../../features/agent/AgentPresets';
import { WorkspaceDialog } from '../../features/agent/WorkspacePanels';
import { sidebarAgents } from '../../features/agent/sidebarModel';
import { useAgentStore } from '../../features/agent/store';
import { deleteAgentPreset, flushWorkspace, recruitAgentToTask, selectTask, setAgentProjectAssignment, useWorkspaceStore } from '../../features/agent/workspace';
import type { AgentPreset } from '../../features/agent/workspaceModel';
import { useControlStore } from '../../store/control';
import { cloudSelection, useOpenAi } from '../../features/openai/store';

type SidebarAgentStatus='working'|'waiting'|'idle'|'offline';
function canStart(agent:ReturnType<typeof sidebarAgents>[number],task:typeof agent.tasks[number]|undefined,cloud:ReturnType<typeof useOpenAi.getState>,runs:ReturnType<typeof useControlStore.getState>['runs']){
  const preset=agent.preset;
  if(agent.runtime==='codex'||agent.runtime==='claude'){
    const selection=cloudSelection(cloud,agent.runtime==='claude'?'claude':'openai',task?.connectionId,preset?.connectionProfileId);
    return selection.installed&&selection.status.connected;
  }
  if(task?.autoStartServer??preset?.autoStartServer)return true;
  const activeRuns=runs.filter(run=>['ready','busy'].includes(run.info.state));
  const binding=task?.binding??preset?.binding;
  return binding?.runId?activeRuns.some(run=>run.info.runId===binding.runId):activeRuns.length>0;
}
function agentStatus(agent:ReturnType<typeof sidebarAgents>[number],threads:ReturnType<typeof useAgentStore.getState>['threads'],cloud:ReturnType<typeof useOpenAi.getState>,runs:ReturnType<typeof useControlStore.getState>['runs']):SidebarAgentStatus{
  const sessions=agent.tasks.filter(task=>task.presetId===agent.preset?.id).flatMap(task=>{const thread=threads[task.id];return thread?[thread]:[];});
  if(sessions.some(thread=>thread.requests.length))return 'waiting';
  if(sessions.some(thread=>thread.pending||thread.starting))return 'working';
  if(sessions.some(thread=>thread.id&&!thread.ended&&!thread.error))return 'idle';
  const candidates=agent.tasks.length?agent.tasks:[undefined];
  return candidates.some(task=>canStart(agent,task,cloud,runs))?'idle':'offline';
}
const statusLed:Record<SidebarAgentStatus,string>={working:'busy',waiting:'waiting',idle:'ready',offline:'crashed'};

export function SidebarAgents() {
  const {t}=useTranslation();
  const threads=useAgentStore(s=>s.threads);
  const cloud=useOpenAi();
  const presets=useWorkspaceStore(s=>s.presets),tasks=useWorkspaceStore(s=>s.tasks),projects=useWorkspaceStore(s=>s.projects);
  const selectedTaskId=useWorkspaceStore(s=>s.selectedTaskId);
  const runs=useControlStore(s=>s.runs),activeView=useControlStore(s=>s.activeView),setView=useControlStore(s=>s.setView);
  const [menu,setMenu]=useState<AgentMenuTarget>(),[remove,setRemove]=useState<AgentPreset>();
  const agents=sidebarAgents(presets,tasks,threads);
  const selectedTask=tasks.find(task=>task.id===selectedTaskId&&!task.deletedAt&&!task.archived);
  const currentMenuPreset=presets.find(preset=>preset.id===menu?.preset.id);
  const closeMenu=useCallback(()=>setMenu(undefined),[]);
  const showMenu=(preset:AgentPreset,event:MouseEvent|KeyboardEvent)=>{
    event.preventDefault();event.stopPropagation();
    const bounds=event.currentTarget.getBoundingClientRect();
    setMenu({preset,x:'clientX' in event?event.clientX:bounds.right,y:'clientY' in event?event.clientY:bounds.bottom});
  };
  const recruited=!!selectedTask?.collaboratorPresetIds?.includes(menu?.preset.id??'');
  return <section className="deskSideAgents" aria-label={t('desk.agents.title')}>
    <div className="kServersHead"><Bot className="deskRailAgentIcon" size={15}/><span>{t('desk.agents.title')}</span><span className="kMono">{agents.length}</span><button type="button" className="kIconBtn" aria-label={t('presets.manage')} title={t('presets.manage')} onClick={openAgentPresets}><Plus size={14}/></button></div>
    <div className="kServerList">
      {!agents.length&&<p className="kEmptyNote">{t('desk.agents.none')}</p>}
      {agents.map((agent,index)=>{
        const task=agent.tasks.find(task=>task.id===selectedTaskId)??agent.tasks[0];
        const state=agentStatus(agent,threads,cloud,runs),status=t(`desk.agents.status.${state}`);
        const assignedProjectIds=new Set([...(agent.preset?.projectIds??[]),...agent.tasks.map(task=>task.projectId)]);
        const assignedProjects=[...assignedProjectIds].map(id=>projects.find(project=>project.id===id)?.name).filter((name):name is string=>!!name);
        const projectSummary=assignedProjects.length?assignedProjects.slice(0,2).join(', '):t('presets.noProjectsAssigned');
        const projectTail=assignedProjects.length>2?` +${assignedProjects.length-2}`:'';
        const sessions=agent.tasks.filter(task=>task.presetId===agent.preset?.id).filter(task=>{const session=threads[task.id];return !!session&&!session.ended&&(!!session.id||session.starting);}).length;
        const details=[agentName(agent.runtime),projectSummary+projectTail,status,sessions>0?t('desk.agents.sessions',{count:sessions}):undefined].filter(Boolean).join(' · ');
        const selected=activeView==='agentWorkspace'&&agent.tasks.some(task=>task.id===selectedTaskId);
        const open=()=>{if(task){selectTask(task.id);setView('agentWorkspace');}else if(agent.preset)openAgentPreset(agent.preset.id);};
        return <button type="button" key={agent.id} className={`kRun deskAgentRow${selected?' isSelected':''}`} title={`${agent.name} · ${details}`} aria-current={selected?'true':undefined} aria-haspopup="menu" aria-expanded={menu?.preset.id===agent.preset?.id} onClick={open} onContextMenu={event=>agent.preset&&showMenu(agent.preset,event)} onKeyDown={event=>{if(agent.preset&&(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey))showMenu(agent.preset,event);}}>
          <span className={`kLed is-${statusLed[state]}`} aria-hidden="true"/>
          <span className="kRunText"><b><AgentIcon runtime={agent.runtime}/>{agent.name}</b><small>{details}</small></span><span className="kRailCh" aria-hidden="true">A{index+1}</span>
        </button>;
      })}
    </div>
    <AgentActionsMenu target={menu} preset={currentMenuPreset} projects={projects} task={selectedTask} recruited={recruited} onClose={closeMenu} onConfigure={openAgentPreset} onProject={(presetId,projectId,assigned)=>{setAgentProjectAssignment(presetId,projectId,assigned);void flushWorkspace();}} onRecruit={(taskId,presetId,value)=>{recruitAgentToTask(taskId,presetId,value);void flushWorkspace();}} onDelete={setRemove}/>
    {remove&&<WorkspaceDialog title={t('profiles.action.delete')} onClose={()=>setRemove(undefined)}><p>{t('presets.deleteConfirm',{name:remove.name})}</p><p className="awMuted">{t('presets.deleteEmployeeHint')}</p><div className="awDialogActions"><Button type="button" onClick={()=>setRemove(undefined)}>{t('aw.cancel')}</Button><Button type="button" className="awDangerButton" onClick={()=>{deleteAgentPreset(remove.id);setRemove(undefined);void flushWorkspace();}}>{t('profiles.action.delete')}</Button></div></WorkspaceDialog>}
  </section>;
}
