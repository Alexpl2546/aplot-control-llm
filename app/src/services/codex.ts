import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { codexRpc } from '../features/openai/store';
import { codexApproval, codexFrames, codexPolicy, type CodexEvent } from '../features/openai/codexProtocol';
import type { AgentStart } from './agent';
import type { AgentFrame } from '../features/agent/store';
import type { AgentAttachment, AccessMode } from '../features/agent/ioModel';

interface Session {children:Set<string>;connectionId?:string;threadId:string;turnId?:string;startingTurn?:boolean;stopRequested?:boolean;completedTurns:number;emit:(frame:AgentFrame)=>void;mode:AccessMode;cwd:string;model:string;requests:Map<string,CodexEvent>;context?:unknown;}
const sessions=new Map<string,Session>();
let listening:Promise<unknown>|undefined;
function subscribe(){
  if(!listening)listening=listen<CodexEvent>('codex://event',({payload:event})=>{
    if(event.method==='aplot/closed'){const connection=(event as CodexEvent & {aplotConnectionId?:string}).aplotConnectionId;for(const [id,s] of sessions)if(!connection||s.connectionId===connection){s.emit({kind:'closed'});sessions.delete(id);}return;}
    const p=event.params??{};
    if(event.method==='account/updated'&&p.authMode===null){const connection=(event as CodexEvent & {aplotConnectionId?:string}).aplotConnectionId;for(const [id,s] of sessions)if(!connection||s.connectionId===connection){s.emit({kind:'closed'});sessions.delete(id);}return;}
    const item=p.item as {type?:string;receiverThreadIds?:string[]}|undefined;
    const session=[...sessions.values()].find(s=>(!(event as CodexEvent & {aplotConnectionId?:string}).aplotConnectionId||s.connectionId===(event as CodexEvent & {aplotConnectionId?:string}).aplotConnectionId)&&(s.threadId===p.threadId||s.children.has(String(p.threadId))));if(!session)return;
    if(item?.type==='collabAgentToolCall')for(const id of item.receiverThreadIds??[])if(session.children.size<32)session.children.add(id);
    if(session.threadId!==p.threadId&&event.id===undefined){if(event.method==='turn/completed')session.emit({kind:'event',type:'agent.update',payload:{id:p.threadId,name:'Codex',status:(p.turn as {status?:string})?.status??'unknown'}});return;}
    if(event.method==='turn/started')session.turnId=String((p.turn as {id?:string})?.id??'');
    if(event.id!==undefined)session.requests.set(JSON.stringify(event.id),event);
    for(const frame of codexFrames(event)){if(frame.type==='session.usage')session.context=frame.payload?.usage;session.emit(frame);}
    if(event.method==='turn/completed'){session.completedTurns++;session.turnId=undefined;session.startingTurn=false;session.requests.clear();}
  }).catch(e=>{listening=undefined;throw e;});return listening;
}
export async function startCodex(request:AgentStart,onFrame:(frame:AgentFrame)=>void){
  await subscribe();
  const mode=request.accessMode??'manual',policy=codexPolicy(mode,request.cwd);
  const instructions=[request.language==='ru'?'Общайся с пользователем на русском языке.':'Use the user’s language.',request.context??'',request.skills?`Project skill references selected by the user: ${request.skills}`:''].filter(Boolean).join('\n\n');
  const result=await codexRpc<{thread:{id:string};model?:string}>(request.nativeSessionId?'thread/resume':'thread/start',{...(request.nativeSessionId?{threadId:request.nativeSessionId}:{}),aplotConnectionId:request.connectionId,cwd:request.cwd,model:request.modelId,approvalPolicy:policy.approvalPolicy,sandbox:policy.sandbox,developerInstructions:instructions});
  sessions.set(request.id,{children:new Set(),connectionId:request.connectionId,threadId:result.thread.id,emit:onFrame,mode,cwd:request.cwd,model:request.modelId??result.model??'',requests:new Map(),completedTurns:0});
  onFrame({kind:'event',type:'session.created',payload:{runtime:'codex',connectionId:request.connectionId,sessionId:result.thread.id,modelId:request.modelId??result.model}});
}
export async function promptCodex(id:string,text:string,attachments:AgentAttachment[]=[]){
  const s=sessions.get(id);if(!s)throw new Error('closed');if(s.turnId||s.startingTurn)throw new Error('busy');
  const policy=codexPolicy(s.mode,s.cwd);
  const files=attachments.filter(a=>a.kind!=='image');
  const input=[{type:'text',text:text+(files.length?`\n\nFiles explicitly attached by the user:\n${files.map(a=>a.path).join('\n')}`:'')},...attachments.filter(a=>a.kind==='image').map(a=>({type:'localImage',path:a.path}))];
  const completed=s.completedTurns;s.startingTurn=true;s.stopRequested=false;
  try {const r=await codexRpc<{turn:{id:string}}> ('turn/start',{...(s.connectionId?{aplotConnectionId:s.connectionId}:{}),threadId:s.threadId,input,model:s.model,approvalPolicy:policy.approvalPolicy,sandboxPolicy:policy.sandboxPolicy});if(s.completedTurns===completed){s.turnId=r.turn.id;if(s.stopRequested||!sessions.has(id))await codexRpc('turn/interrupt',{aplotConnectionId:s.connectionId,threadId:s.threadId,turnId:r.turn.id});}}
  finally{s.startingTurn=false;}
}
export async function stopCodex(id:string,close:boolean){
  const s=sessions.get(id);if(!s)return;
  s.stopRequested=true;
  if(s.turnId)await codexRpc('turn/interrupt',{aplotConnectionId:s.connectionId,threadId:s.threadId,turnId:s.turnId});
  for(const [requestId,event]of s.requests)await invoke('codex_respond',{requestId,result:codexApproval(event,{choice:'deny',answers:{}})}).catch(()=>undefined);
  s.requests.clear();if(close){sessions.delete(id);s.emit({kind:'closed'});}
}
export async function respondCodex(id:string,requestId:string,result:Record<string,unknown>){
  const s=sessions.get(id),request=s?.requests.get(requestId);if(!request)throw new Error('expired');
  await invoke('codex_respond',{requestId,result:codexApproval(request,result)});s!.requests.delete(requestId);
}
export function codexContext(id:string){return sessions.get(id)?.context;}
export function codexAccess(id:string,mode:AccessMode){const s=sessions.get(id);if(!s)throw new Error('closed');s.mode=mode;}
export async function closeCodexSessions(){for(const id of [...sessions.keys()])await stopCodex(id,true);}
