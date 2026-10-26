import { create } from 'zustand';
import { useControlStore } from '../../store/control';
import { useAgentStore } from '../agent/store';
import { useWorkspaceStore } from '../agent/workspace';
import { toolPath } from '../agent/workspaceModel';
import { loadActivity, saveActivity } from '../../services/activity';
import { isActivityEvent, lifecycleChanged, type ActivityEvent } from './model';

export const useActivityStore=create<{events:ActivityEvent[];error:boolean;mode:'events'|'technical';setMode:(mode:'events'|'technical')=>void}>(set=>({events:[],error:false,mode:'events',setMode:mode=>set({mode})}));
let loaded=false;
export function addActivity(event:Omit<ActivityEvent,'id'|'time'>) {
  const row={...event,id:crypto.randomUUID(),time:Date.now()};
  useActivityStore.setState(s=>({events:[row,...s.events].slice(0,500)}));
  void saveActivity(row).catch(()=>useActivityStore.setState({error:true}));
}
export function startActivityMonitor() {
  if(!loaded){loaded=true;void loadActivity().then(rows=>useActivityStore.setState(s=>({events:[...new Map([...s.events,...rows.filter(isActivityEvent)].map(e=>[e.id,e])).values()].sort((a,b)=>b.time-a.time).slice(0,500)}))).catch(()=>useActivityStore.setState({error:true}));}
  const offControl=useControlStore.subscribe((s,old)=>{
    for(const run of s.runs){
      const previous=old.runs.find(r=>r.info.runId===run.info.runId);
      if(lifecycleChanged(previous?.info,run.info))addActivity({kind:'server.state',level:run.info.state==='crashed'?'error':'info',name:run.info.name,runId:run.info.runId,data:{state:run.info.state,engine:run.info.engine,profile:run.config.profileName,context:run.info.contextTokens,endpoint:run.info.endpoint,generation:run.info.generation}});
      if(run.logs!==previous?.logs){const seen=new Set(previous?.logs.map(l=>l.id));const issues=run.logs.filter(l=>!seen.has(l.id)&&['WARN','ERROR'].includes(l.level));for(const line of issues.slice(-10))addActivity({kind:'server.issue',level:line.level==='ERROR'?'error':'warn',name:run.info.name,runId:run.info.runId,data:{message:line.message.slice(0,1800),source:line.source}});}
    }
    if(s.profiles!==old.profiles&&old.profiles.length)for(const profile of s.profiles){const previous=old.profiles.find(p=>p.id===profile.id);if(!previous||JSON.stringify(previous.config)!==JSON.stringify(profile.config))addActivity({kind:'profile.saved',level:'info',name:profile.name,data:{engine:profile.config.engine??'llama_cpp',context:profile.config.ctxSize}});}
  });
  const offAgent=useAgentStore.subscribe((s,old)=>{
    if(s.threads===old.threads)return;
    for(const [taskId,thread] of Object.entries(s.threads)){
      const previous=old.threads[taskId];if(previous===thread)continue;
      // Restoring an archived transcript is not execution of its old tools.
      if(!previous&&!thread.id&&!thread.pending)continue;
      const task=useWorkspaceStore.getState().tasks.find(t=>t.id===taskId),name=task?.title??'Hermes',runId=task?.binding?.runId;
      const push=(kind:ActivityEvent['kind'],data:ActivityEvent['data'],level:ActivityEvent['level']='info')=>addActivity({kind,data,level,name,taskId,runId});
      if(thread.id&&!thread.starting&&(thread.id!==previous?.id||previous?.starting))push('agent.started',{agent:'Hermes',mode:thread.accessMode??'manual'});
      if(previous?.pending&&!thread.pending&&!thread.starting)push('agent.completed',{outcome:thread.error?'error':thread.stopped?'interrupted':'success'},thread.error?'error':'info');
      if(previous?.id&&!thread.id&&thread.ended)push('agent.closed',{agent:'Hermes'});
      if(thread.entries!==previous?.entries)for(const entry of thread.entries){if(entry.kind!=='tool'||entry.status==='running')continue;const oldEntry=previous?.entries.find(e=>e.id===entry.id);if(oldEntry?.status===entry.status)continue;push('agent.tool',{tool:entry.name??'',path:toolPath(entry.args,entry.result),outcome:entry.status??'unknown'},entry.status==='error'?'error':entry.status==='denied'?'warn':'info');}
    }
  });
  return()=>{offControl();offAgent();};
}
