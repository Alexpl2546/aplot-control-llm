import { useControlStore } from '../../store/control';
import { bindRun } from './workspaceModel';
import { editTask } from './workspace';
import { startAgent, promptAgent, stopAgent, respondAgent, agentVoice } from '../../services/agent';
import { useAgentStore, agentFrame, type AgentThread, type AgentFrame, type QueuedPrompt } from './store';
import { memoryContext } from './workspaceModel';
import { addActivity } from '../activity/store';
import { useWorkspaceStore, flushWorkspace } from './workspace';
import { hostOwns, sendHostMessage } from './hostTasks';
import { cancelHostTurn, interruptHostTask, resetHostTask, resolveHostApproval, resumeHostTask } from '../../services/agentTasks';

type Target = { runId: string; generation: number; language: string };
function runtimeTarget(key:string){const task=useWorkspaceStore.getState().tasks.find(t=>t.id===key);const thread=useAgentStore.getState().threads[key];return task?.runtime==='codex'||task?.runtime==='claude'?{runtime:task.runtime,modelId:task.cloudModel??task.codexModel,connectionId:task.connectionId,nativeSessionId:thread?.nativeRuntime===task.runtime&&thread.nativeConnectionId===task.connectionId?thread.nativeSessionId:undefined}:{};}
export function agentInstructions(key:string,thread:AgentThread){const task=useWorkspaceStore.getState().tasks.find(t=>t.id===key);return [task?.instructions?.trim(),memoryContext(thread.appliedMemory??[])].filter(Boolean).join('\n\n');}
const edit = (key: string, update: (thread: AgentThread) => AgentThread) => useAgentStore.getState().update(key, update);
const taskOf = (key:string) => useWorkspaceStore.getState().tasks.find(t=>t.id===key);
/** The host owns this task's runtime session; the window only sends commands. */
export const isHostTask = (key:string) => hostOwns(taskOf(key)?.runtime);
async function sendHost(key:string,language:string){
  const thread=useAgentStore.getState().threads[key],task=taskOf(key);
  if(!task||!thread||(!thread.draft.trim()&&!thread.attachments?.length)||thread.ended||(thread.voiceStatus&&thread.voiceStatus!=='idle'))return;
  const text=thread.draft.trim(),attachments=thread.attachments??[];
  edit(key,s=>({...s,draft:'',attachments:[],error:'',ioError:''}));
  try {
    // The host resolves the project folder from the saved workspace, so a new task must be saved first.
    await flushWorkspace();
    await sendHostMessage({commandId:crypto.randomUUID(),taskId:key,runtime:task.runtime??'hermes',text,attachments,config:{modelId:task.cloudModel??task.codexModel,connectionId:task.connectionId,accessMode:thread.accessMode??task.accessMode??'manual',language,context:agentInstructions(key,thread),skills:thread.skills}});
  } catch(error){edit(key,s=>({...s,error:errorCode(error),ioError:String(error),draft:[text,s.draft].filter(Boolean).join('\n\n'),attachments:[...attachments,...(s.attachments??[])]}));}
}
const cancelledStarts = new Set<string>();
function receiveFrame(key:string,id:string,target:Target,frame:AgentFrame) {
  const current=useAgentStore.getState().threads[key];
  if(current?.id!==id)return;
  const sendAfter=frame.type==='voice.transcript'&&current.voiceSendAfter&&!current.voiceDiscard&&typeof frame.payload?.text==='string'&&!!frame.payload.text.trim()&&!frame.payload.stop_phrase;
  edit(key,s=>s.id===id?agentFrame(s,frame):s);
  if(sendAfter)void sendAgent(key,target);
  if(frame.type==='message.complete'&&frame.payload?.status==='complete'){const next=useAgentStore.getState().threads[key];if(next&&!next.pending&&!next.ended&&!next.error&&!next.stopped&&next.queue?.length)void sendQueuedAgent(key,target);}
}
export async function finishAgentDictation(key:string,sendAfter=false) {
  const thread=useAgentStore.getState().threads[key];
  if(!thread?.id||!['listening','recording'].includes(thread.voiceStatus??''))return;
  edit(key,s=>({...s,voiceStatus:'transcribing',voiceSendAfter:sendAfter}));
  try {await agentVoice(thread.id,'stop');}
  catch(error){edit(key,s=>s.id===thread.id?({...s,voiceStatus:'idle',voiceSendAfter:false,ioError:String(error)}):s);}
}
export async function cancelAgentDictation(key:string) {
  const thread=useAgentStore.getState().threads[key];
  if(!thread||!thread.voiceStatus||thread.voiceStatus==='idle')return;
  edit(key,s=>({...s,voiceDiscard:true,voiceSendAfter:false,voiceStatus:'cancelling'}));
  // Startup checks voiceDiscard before opening the microphone.
  if(thread.voiceStatus==='starting')return;
  if(!thread.id){edit(key,s=>({...s,voiceStatus:'idle'}));return;}
  try {await agentVoice(thread.id,'cancel');if(thread.voiceStatus!=='transcribing')edit(key,s=>s.id===thread.id?({...s,voiceStatus:'idle',voiceStartedAt:undefined}):s);}
  catch(error){edit(key,s=>({...s,ioError:String(error)}));}
}
export async function resolveAgentServer(key:string,target:Target,id:string):Promise<Target>{
  const task=useWorkspaceStore.getState().tasks.find(t=>t.id===key);if(!task?.autoStartServer||task.runtime==='codex'||task.runtime==='claude')return target;
  const runId=task.binding?.runId;if(!runId)throw new Error('server-missing');
  let state=useControlStore.getState(),run=state.runs.find(r=>r.info.runId===runId);
  if(!run&&runId.startsWith('profile:')){await state.saveServer(runId.slice(8));state=useControlStore.getState();run=state.runs.find(r=>r.info.runId===runId);}
  if(!run)throw new Error('server-missing');
  if(!['ready','busy','starting','loading','restarting'].includes(run.info.state)){
    if((state.selectedRunId===runId&&state.dirty)||state.runDrafts[runId]?.dirty)throw new Error('profile-needs-review');
    await state.startManagedRun(runId);
    if(useControlStore.getState().error)throw new Error('server-start-failed');
  }
  const deadline=Date.now()+300000;
  while(Date.now()<deadline){
    if(cancelledStarts.has(id)||useAgentStore.getState().threads[key]?.id!==id)throw new Error('closed');
    const run=useControlStore.getState().runs.find(r=>r.info.runId===runId);
    if(run&&['ready','busy'].includes(run.info.state)){
      if(run.info.contextTokens<64000)throw new Error('context');editTask(key,{binding:bindRun(run.info,run.config?.profileName)});
      return {...target,runId,generation:run.info.generation};
    }
    if(!run||['stopped','crashed'].includes(run.info.state))throw new Error('server-start-failed');
    await new Promise(resolve=>setTimeout(resolve,500));
  }throw new Error('server-timeout');
}
export async function prepareAgent(key:string,target:Target):Promise<string> {
  // Voice capture belongs to the Hermes window path; host tasks have none yet.
  if(isHostTask(key))throw new Error('voice-not-configured');
  const thread=useAgentStore.getState().threads[key];
  if(!thread||thread.ended||thread.starting||!thread.cwd)throw new Error('busy');
  if(thread.id)return thread.id;
  const id=crypto.randomUUID();
  edit(key,s=>({...s,id,starting:true,error:''}));
  const apply=(update:(s:AgentThread)=>AgentThread)=>edit(key,s=>s.id===id?update(s):s);
  try {
    if(useWorkspaceStore.getState().tasks.find(t=>t.id===key)?.autoStartServer)target=await resolveAgentServer(key,target,id);
    await startAgent({id,...target,...runtimeTarget(key),cwd:thread.cwd,skills:thread.skills,context:agentInstructions(key,thread),homeId:key,accessMode:thread.accessMode??'manual'},frame=>receiveFrame(key,id,target,frame));
    if(cancelledStarts.has(id)||useAgentStore.getState().threads[key]?.id!==id){await stopAgent(id,true).catch(()=>undefined);throw new Error('closed');}
    apply(s=>({...s,starting:false}));return id;
  } catch(error){apply(s=>({...s,id:undefined,starting:false}));throw error;}
  finally {cancelledStarts.delete(id);}
}
function errorCode(error: unknown) { const code = String(error).replace(/^Error: /, ''); return ['not-installed','changed','unavailable','folder','closed','limit','busy','expired','context','runtime-failed'].includes(code) ? code : 'agent-error'; }
export function enqueueAgent(key:string,language='en'){
  if(isHostTask(key)){void sendHost(key,language);return;}
  const thread=useAgentStore.getState().threads[key];if(!thread||(!thread.draft.trim()&&!thread.attachments?.length)||(thread.queue?.length??0)>=10)return;
  edit(key,s=>({...s,draft:'',attachments:[],queue:[...(s.queue??[]),{id:crypto.randomUUID(),text:s.draft.trim(),attachments:s.attachments,time:Date.now()}]}));
}
export async function sendQueuedAgent(key:string,target:Target){if(isHostTask(key)){await resumeHostTask(key).catch(error=>edit(key,s=>({...s,error:errorCode(error)})));return;}const thread=useAgentStore.getState().threads[key];if(!thread||thread.pending||thread.starting||thread.ended||!thread.queue?.length)return;await sendAgent(key,target,thread.queue[0]);}
export async function sendAgent(key: string, target: Target, queued?:QueuedPrompt) {
  if (isHostTask(key)) { if (queued) await sendQueuedAgent(key,target); else await sendHost(key,target.language); return; }
  const thread = useAgentStore.getState().threads[key];
  if ((!queued&&!thread?.draft.trim() && !thread?.attachments?.length) || thread.pending || thread.starting || thread.ended || !thread.cwd || (thread.voiceStatus && thread.voiceStatus!=='idle')) return;
  const id = thread.id ?? crypto.randomUUID(), prompt = queued?.text??thread.draft.trim(), attachments=queued?.attachments??thread.attachments;
  const entryId=crypto.randomUUID();
  edit(key, s => ({ ...s, id, draft: queued?s.draft:'', attachments:queued?s.attachments:[], queue:queued?s.queue?.filter(q=>q.id!==queued.id):s.queue, pending: true, starting: !thread.id, error: '', ioError:'', stopped: false, cursor: undefined, entries: [...s.entries, { id: entryId, kind: 'user', text: prompt, attachments, time:Date.now() }] }));
  const apply = (update: (s: AgentThread) => AgentThread) => edit(key, s => s.id === id ? update(s) : s);
  let started = !!thread.id;
  try {
    if (!thread.id&&useWorkspaceStore.getState().tasks.find(t=>t.id===key)?.autoStartServer) target=await resolveAgentServer(key,target,id);
    if (!thread.id) await startAgent({ id, ...target,...runtimeTarget(key), cwd: thread.cwd, skills: thread.skills, context: agentInstructions(key,thread),homeId:key,accessMode:thread.accessMode??'manual' }, frame => receiveFrame(key,id,target,frame));
    started = true;
    if (cancelledStarts.has(id)) { await stopAgent(id, true).catch(() => undefined); apply(s => ({ ...s, pending: false, starting: false, ended: true, stopped: true })); return; }
    apply(s => ({ ...s, starting: false }));
    if (useAgentStore.getState().threads[key]?.id !== id) { await stopAgent(id,true).catch(()=>undefined); return; }
    await promptAgent(id, prompt,attachments);
  } catch (error) { apply(s => ({ ...s, id: started ? id : undefined, pending: false, starting: false, error: errorCode(error),ioError:String(error),draft:[prompt,s.draft].filter(Boolean).join('\n\n'),attachments:[...(attachments??[]),...(s.attachments??[])],entries:s.entries.filter(e=>e.id!==entryId) })); }
  finally { cancelledStarts.delete(id); }
}
/** Removes a waiting message before it runs. */
export async function removeQueuedAgent(key:string,id:string){
  if(isHostTask(key)){await cancelHostTurn(key,id).catch(error=>edit(key,s=>({...s,error:errorCode(error)})));return;}
  edit(key,s=>({...s,queue:s.queue?.filter(q=>q.id!==id)}));
}
/** Ends the runtime session and forgets the native thread before a new session with handoff. */
export async function resetAgentSession(key:string){
  if(isHostTask(key)){await resetHostTask(key);return true;}
  return useAgentStore.getState().threads[key]?.id?interruptAgent(key,true):true;
}
export async function interruptAgent(key: string, close = false) {
  if (isHostTask(key)) {
    try { await interruptHostTask(key, close); return true; }
    catch (error) { edit(key, s => ({ ...s, error: errorCode(error) })); return false; }
  }
  const thread = useAgentStore.getState().threads[key], id = thread?.id; if (!id) return true;
  if (thread.starting) cancelledStarts.add(id);
  if (close || thread.starting) edit(key, s => ({ ...s, ended: true }));
  try { await stopAgent(id, close || thread.starting); return true; }
  catch (error) {
    // A worker still starting must remain cancelled even if the first stop RPC
    // arrives before native registration. sendAgent closes it after startup.
    if (!thread.starting) {
      cancelledStarts.delete(id);
      edit(key, s => s.id===id ? ({ ...s, ended:thread.ended, error:errorCode(error) }) : s);
    }
    return false;
  }
}
function approvalActivity(key:string,result:Record<string,unknown>){if(typeof result.choice==='string')addActivity({kind:'agent.approval',level:result.choice==='deny'?'warn':'info',name:useWorkspaceStore.getState().tasks.find(t=>t.id===key)?.title??'Hermes',taskId:key,data:{choice:result.choice}});}
export async function answerAgent(key: string, requestId: string, result: Record<string, unknown>) {
  if (isHostTask(key)) {
    // The first answer from any client wins; a later one sees the recorded outcome.
    try { const outcome=await resolveHostApproval(requestId,result); if(!outcome.alreadyResolved)approvalActivity(key,result); edit(key,s=>({...s,requests:s.requests.filter(r=>r.id!==requestId)})); return true; }
    catch (error) { edit(key, s => ({ ...s, error: errorCode(error) })); return false; }
  }
  const id = useAgentStore.getState().threads[key]?.id; if (!id) return false;
  try { await respondAgent(id, requestId, result); approvalActivity(key,result);edit(key, s => ({ ...s, requests: s.requests.filter(r => r.id !== requestId) })); return true; }
  catch (error) { edit(key, s => ({ ...s, error: errorCode(error) })); return false; }
}
