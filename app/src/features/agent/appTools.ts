import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import i18n from '../../lib/i18n';
import { isTauri } from '../../services/tauri';
import { sendAgent } from './generation';
import { useAgentStore } from './store';
import { assignAgentPreset, createTask, editTask, flushWorkspace, recruitAgentToTask, saveAgentPreset, useWorkspaceStore } from './workspace';
import type { AgentPreset, AgentTask } from './workspaceModel';

export interface AppToolRequest { requestId:string; taskId:string; name:string; arguments:Record<string,unknown>; }
export interface AgentProposal { requestId:string; taskId:string; agent:AgentPreset; }
export const useAgentProposals = create<{items:AgentProposal[]}>(()=>({items:[]}));
const approvals = new Map<string,(value:unknown)=>void>();
const rank = {restricted:0,manual:1,full:2} as const;
const activeTask = (id:string) => {
  const task=useWorkspaceStore.getState().tasks.find(task=>task.id===id&&!task.deletedAt&&!task.archived);
  if(!task)throw new Error('Caller task is unavailable');
  return task;
};
const required = (args:Record<string,unknown>,name:string,max=16000) => {
  const value=args[name];
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Invalid ${name}`);
  return value.trim();
};
function descendants(id:string,tasks:AgentTask[]):Set<string> {
  const result=new Set<string>();
  for(let pass=0;pass<tasks.length;pass++){
    const before=result.size;
    for(const task of tasks)if(task.parentTaskId&&(task.parentTaskId===id||result.has(task.parentTaskId)))result.add(task.id);
    if(result.size===before)break;
  }
  return result;
}
function inherited(task:AgentTask):Pick<AgentPreset,'runtime'|'model'|'connectionProfileId'|'binding'|'accessMode'|'reasoning'|'autoStartServer'> {
  return {runtime:task.runtime??'hermes',model:task.cloudModel??task.codexModel,connectionProfileId:task.connectionProfileId,binding:task.binding?structuredClone(task.binding):undefined,accessMode:useAgentStore.getState().threads[task.id]?.accessMode??task.accessMode??'manual',reasoning:task.reasoning,autoStartServer:task.autoStartServer};
}
async function saved() {
  await flushWorkspace();
  if(useWorkspaceStore.getState().saveError)throw new Error('Workspace could not be saved');
}

/** Called only by the app's explicit approval buttons, never exposed as an agent tool. */
export async function resolveAgentProposal(requestId:string,approved:boolean) {
  const proposal=useAgentProposals.getState().items.find(item=>item.requestId===requestId);
  const reply=approvals.get(requestId);
  if(!proposal||!reply)return;
  // Consume first: double-clicks cannot create duplicate agents.
  approvals.delete(requestId);
  useAgentProposals.setState(state=>({items:state.items.filter(item=>item.requestId!==requestId)}));
  if(!approved){reply({error:'User declined creating the agent'});return;}
  try{
    const parent=activeTask(proposal.taskId);
    const thread=useAgentStore.getState().threads[proposal.taskId];
    if(!thread?.pending&&!thread?.starting)throw new Error('Caller is no longer running');
    if(rank[inherited(parent).accessMode]<rank[proposal.agent.accessMode])throw new Error('Caller access changed; review a new proposal');
    saveAgentPreset(proposal.agent);
    await saved();
    reply({agentId:proposal.agent.id,name:proposal.agent.name,created:true});
  }catch(error){
    useWorkspaceStore.setState(state=>({presets:state.presets.filter(agent=>agent.id!==proposal.agent.id)}));
    reply({error:String(error)});
  }
}
export function cancelAgentProposal(requestId:string) {
  const reply=approvals.get(requestId);approvals.delete(requestId);
  useAgentProposals.setState(state=>({items:state.items.filter(item=>item.requestId!==requestId)}));
  reply?.({error:'App tool request expired'});
}

export async function handleAppTool(request:AppToolRequest):Promise<unknown> {
  const parent=activeTask(request.taskId),ws=useWorkspaceStore.getState();
  const caller=useAgentStore.getState().threads[parent.id];
  if(!caller?.pending&&!caller?.starting)throw new Error('Caller is no longer running');
  const args=request.arguments??{};
  switch(request.name){
    case 'aplot_delegate':{
      const agentId=required(args,'agentId',100),prompt=required(args,'prompt');
      const projectId=typeof args.projectId==='string'?args.projectId:parent.projectId;
      const agent=ws.presets.find(agent=>agent.id===agentId);
      if(!agent||!ws.projects.some(project=>project.id===projectId))throw new Error('Unknown agent or project');
      if(agent.projectIds?.length&&!agent.projectIds.includes(projectId))throw new Error('Agent is not assigned to this project');
      if(agent.id===parent.presetId)throw new Error('Choose another specialist instead of delegating to yourself');
      let root=parent,depth=0;
      const seen=new Set<string>([parent.id]);
      while(root.parentTaskId){
        const ancestor=ws.tasks.find(task=>task.id===root.parentTaskId);
        if(!ancestor||seen.has(ancestor.id))throw new Error('Invalid delegation ancestry');
        seen.add(ancestor.id);root=ancestor;depth++;
      }
      const children=descendants(root.id,ws.tasks);
      const active=[...children].filter(id=>{
        const thread=useAgentStore.getState().threads[id];
        return thread&&(thread.pending||thread.starting||!!thread.draft.trim());
      });
      if(depth>=3||active.length>=8)throw new Error('Delegation limit reached; collect existing results first');
      const previous={selectedProjectId:ws.selectedProjectId,selectedTaskId:ws.selectedTaskId};
      const id=createTask(projectId,`${agent.name}: ${prompt.slice(0,80)}`);
      assignAgentPreset(id,agent.id);
      // Unconfigured starter templates use the caller's working model, retaining
      // their own identity and instructions. Explicit specialist settings win.
      const fallback=!agent.model&&!agent.binding?inherited(parent):undefined;
      const parentAccess=caller.accessMode??parent.accessMode??'manual';
      const access=rank[parentAccess]<rank[agent.accessMode]?parentAccess:agent.accessMode;
      editTask(id,{...(fallback?{runtime:fallback.runtime,cloudModel:fallback.model,codexModel:undefined,connectionId:parent.connectionId,connectionProfileId:fallback.connectionProfileId,binding:fallback.binding,autoStartServer:fallback.autoStartServer,reasoning:agent.reasoning??fallback.reasoning}:{}),parentTaskId:parent.id,accessMode:access});
      useWorkspaceStore.setState(previous);
      recruitAgentToTask(parent.id,agent.id,true);
      useAgentStore.getState().update(id,thread=>({...thread,draft:prompt,accessMode:access}));
      await saved();
      const task=activeTask(id);
      await sendAgent(id,{runId:task.binding?.runId??'',generation:task.binding?.generation??0,language:i18n.language});
      const thread=useAgentStore.getState().threads[id];
      return {taskId:id,agentId:agent.id,runtime:task.runtime,status:thread?.error?'error':'started',...(thread?.error?{error:thread.ioError||thread.error}:{}),inheritedExecution:!!fallback};
    }
    case 'aplot_propose_agent':{
      if(approvals.has(request.requestId))throw new Error('Duplicate proposal');
      if(useAgentProposals.getState().items.length>=8)throw new Error('Too many pending proposals');
      const agent:AgentPreset={...inherited(parent),id:crypto.randomUUID(),name:required(args,'name',20),title:required(args,'title',80),instructions:required(args,'instructions'),projectIds:[parent.projectId],color:'#c8f27c'};
      return new Promise(resolve=>{
        approvals.set(request.requestId,resolve);
        useAgentProposals.setState(state=>({items:[...state.items,{requestId:request.requestId,taskId:parent.id,agent}]}));
      });
    }
    default:throw new Error('Unknown app tool');
  }
}

export function startAppToolsMonitor() {
  if(!isTauri())return ()=>undefined;
  let disposed=false;
  const stops:(()=>void)[]=[];
  const requests=new Set<string>();
  const stopThreads=useAgentStore.subscribe(state=>{
    for(const proposal of useAgentProposals.getState().items){
      const thread=state.threads[proposal.taskId];
      if(!thread?.pending&&!thread?.starting)cancelAgentProposal(proposal.requestId);
    }
  });
  void listen<AppToolRequest>('agent-tools://request',event=>{
    if(disposed||requests.has(event.payload.requestId))return;
    const request=event.payload;requests.add(request.requestId);
    void handleAppTool(request).catch(error=>({error:String(error)})).then(result=>{
      if(!disposed&&requests.has(request.requestId))return invoke('agent_tool_reply',{requestId:request.requestId,result});
    }).catch(()=>undefined).finally(()=>requests.delete(request.requestId));
  }).then(stop=>disposed?stop():stops.push(stop));
  void listen<{requestId:string}>('agent-tools://cancel',event=>{requests.delete(event.payload.requestId);cancelAgentProposal(event.payload.requestId);}).then(stop=>disposed?stop():stops.push(stop));
  return ()=>{disposed=true;stopThreads();stops.forEach(stop=>stop());requests.forEach(cancelAgentProposal);};
}
