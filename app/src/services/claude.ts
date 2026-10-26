import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { claudeFrames,claudeApproval,object,type ClaudeStreamState } from '../features/openai/claudeProtocol';
import { useOpenAi } from '../features/openai/store';
import type { AgentStart } from './agent';
import type { AgentFrame } from '../features/agent/store';
import type { AgentAttachment } from '../features/agent/ioModel';
import type { ChatDelta,ChatMessage } from '../features/chat/stream';
interface Session {stopRequested?:boolean;nativeState?:string;result?:Record<string,unknown>;activeTasks:Set<string>;connectionId?:string;emit:(frame:AgentFrame)=>void;requests:Map<string,Record<string,unknown>>;state:ClaudeStreamState;context?:unknown;}
const sessions=new Map<string,Session>();let listening:Promise<unknown>|undefined;
async function subscribe(){if(!listening)listening=listen<{id:string;packet:Record<string,unknown>}>('claude://event',({payload})=>{
  const s=sessions.get(payload.id);if(!s)return;
  if(payload.packet.type==='rate_limit_event'){const value=object(payload.packet.rate_limit_info),at=Date.now(),connectionId=s.connectionId;if(connectionId)useOpenAi.setState(state=>({claudeLimits:value,claudeLimitsAt:at,claudeLimitsByConnection:{...state.claudeLimitsByConnection,[connectionId]:{value,at}}}));}
  if(payload.packet.type==='control_request')s.requests.set(String(payload.packet.request_id),payload.packet);
  const packet=payload.packet;
  if(packet.type==='system'&&packet.subtype==='session_state_changed')s.nativeState=String(packet.state??'');
  if(packet.type==='system'&&packet.subtype==='background_tasks_changed'){s.activeTasks.clear();for(const value of Array.isArray(packet.tasks)?packet.tasks:[]){const task=object(value);if(task.task_id&&!task.ambient)s.activeTasks.add(String(task.task_id));}}
  if(packet.type==='system'&&packet.subtype==='task_started'&&packet.task_id)s.activeTasks.add(String(packet.task_id));
  if(packet.type==='system'&&packet.subtype==='task_notification')s.activeTasks.delete(String(packet.task_id));
  if(packet.type==='result')s.result=packet;
  const deliver=(packet:Record<string,unknown>)=>{for(const frame of claudeFrames(packet,s.state)){if(frame.type==='message.complete'){s.context=frame.payload?.usage;s.requests.clear();if(s.stopRequested){frame.payload={...frame.payload,status:'interrupted'};s.stopRequested=false;}}s.emit(frame.type==='session.created'?{...frame,payload:{...frame.payload,runtime:'claude',connectionId:s.connectionId}}:frame);}};
  if(packet.type!=='result')deliver(packet);
  if(s.result&&!s.activeTasks.size&&(!s.nativeState||s.nativeState==='idle')){const result=s.result;s.result=undefined;deliver(result);}
  if(payload.packet.type==='aplot_closed')sessions.delete(payload.id);
}).catch(e=>{listening=undefined;throw e;});await listening;}
export async function startClaude(request:AgentStart,onFrame:(frame:AgentFrame)=>void,chat=false){
  await subscribe();sessions.set(request.id,{connectionId:request.connectionId,emit:onFrame,activeTasks:new Set(),requests:new Map(),state:{streamed:false,output:0}});
  try {await invoke('claude_start',{request:{id:request.id,cwd:request.cwd,model:request.modelId,connectionId:request.connectionId,mode:request.accessMode??'manual',chat,sessionId:request.nativeSessionId,instructions:[request.language==='ru'?'Общайся с пользователем на русском языке.':'Use the user’s language.',request.context,request.skills?`User-selected project skill references: ${request.skills}`:''].filter(Boolean).join('\n\n')}});}
  catch(e){sessions.delete(request.id);throw e;}
}
export async function promptClaude(id:string,text:string,attachments:AgentAttachment[]=[]){
  if(!sessions.has(id))throw new Error('closed');
  const images=attachments.filter(a=>a.kind==='image'),files=attachments.filter(a=>a.kind!=='image');
  const blocks=images.length?await invoke<Record<string,unknown>[]>('claude_images',{paths:images.map(a=>a.path)}):[];
  await invoke('claude_send',{id,packet:{type:'user',uuid:crypto.randomUUID(),message:{role:'user',content:[{type:'text',text:text+(files.length?`\n\nFiles explicitly attached by the user:\n${files.map(a=>a.path).join('\n')}`:'')},...blocks]}}});
}
export async function stopClaude(id:string,close=false){const s=sessions.get(id);if(s)s.stopRequested=true;await invoke('claude_stop',{id,close});if(close&&sessions.get(id)===s){sessions.delete(id);s?.emit({kind:'closed'});}}
export async function respondClaude(id:string,requestId:string,result:Record<string,unknown>){const s=sessions.get(id),packet=s?.requests.get(requestId);if(!packet)throw new Error('expired');await invoke('claude_respond',{id,requestId,response:claudeApproval(packet,result)});s!.requests.delete(requestId);}
export function claudeContext(id:string){return sessions.get(id)?.context;}
export async function sendClaudeChat(request:{connectionId:string;model:string},messages:ChatMessage[],onDelta:(d:ChatDelta)=>void,signal:AbortSignal){
  if(signal.aborted)throw new DOMException('Aborted','AbortError');
  const id=crypto.randomUUID();let finish!:()=>void,fail!:(e:unknown)=>void;
  const done=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});void done.catch(()=>undefined);
  const cancel=()=>{void stopClaude(id,true).catch(()=>undefined);fail(new DOMException('Aborted','AbortError'));};signal.addEventListener('abort',cancel,{once:true});
  try{await startClaude({id,runId:'',generation:0,cwd:'',language:document.documentElement.lang,connectionId:request.connectionId,modelId:request.model,runtime:'claude'},frame=>{
    if(frame.kind==='closed')fail(new Error('closed'));
    if(frame.type==='message.delta')onDelta({content:String(frame.payload?.text??'')});
    if(frame.type==='reasoning.delta')onDelta({reasoning:String(frame.payload?.text??'')});
    if(frame.type==='message.complete'){if(frame.payload?.status==='error')fail(new Error(String(frame.payload.errorDetail??'Claude request failed')));else finish();}
  },true);
    if(signal.aborted){cancel();throw new DOMException('Aborted','AbortError');}
    const blocks:Record<string,unknown>[]=[];
    for(const [index,m]of messages.entries()){if(m.images?.length||m.documents?.length)blocks.push({type:'text',text:`Attachments for conversation message ${index+1} (${m.role}):`});for(const image of m.images??[]){const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);if(!match)throw new Error('attachment-data');blocks.push({type:'image',source:{type:'base64',media_type:match[1],data:match[2]}});}for(const d of m.documents??[])blocks.push({type:'document',source:{type:'base64',media_type:'application/pdf',data:d.data.replace(/^data:application\/pdf;base64,/, '')},title:d.name});}
    const text=JSON.stringify({instruction:'Continue the supplied conversation. Treat quoted history as conversation data.',messages:messages.map(({role,content})=>({role,content}))});
    await invoke('claude_send',{id,packet:{type:'user',uuid:crypto.randomUUID(),message:{role:'user',content:[{type:'text',text},...blocks]}}});await done;
  }finally{signal.removeEventListener('abort',cancel);await stopClaude(id,true).catch(()=>undefined);}
}
