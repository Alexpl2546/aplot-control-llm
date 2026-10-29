import { startClaude,promptClaude,stopClaude,respondClaude,claudeContext } from './claude';
import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
import type { AgentFrame } from '../features/agent/store';
import type { AccessMode, AgentAttachment } from '../features/agent/ioModel';
import { hostTaskOf } from '../features/agent/taskProjection';
import { setHostTaskAccess } from './agentTasks';
import { startCodex, promptCodex, stopCodex, respondCodex, codexContext, codexAccess } from './codex';

export interface AgentStart { id: string; runId: string; generation: number; cwd: string; skills?: string; language: string; context?: string; homeId?:string; accessMode?:AccessMode; runtime?:'hermes'|'codex'|'claude'; modelId?:string; connectionId?:string; nativeSessionId?:string; reasoning?:string; }
const runtimes=new Map<string,'hermes'|'codex'|'claude'>();
const previews = new Map<string, (frame: AgentFrame) => void>();
const previewTurns = new Map<string, number>();
export async function startAgent(request: AgentStart, onFrame: (frame: AgentFrame) => void) {
  if(request.runtime==='claude'){runtimes.set(request.id,'claude');try{await startClaude(request,onFrame);return;}catch(e){runtimes.delete(request.id);throw e;}}
  if(request.runtime==='codex'){runtimes.set(request.id,'codex');try{await startCodex(request,onFrame);return;}catch(e){runtimes.delete(request.id);throw e;}}
  if (!isTauri()) { previews.set(request.id, onFrame); return; }
  const channel = new Channel<AgentFrame>(); channel.onmessage = onFrame;
  await invoke('hermes_agent_start', { request, onEvent: channel });
}
export async function promptAgent(id: string, text: string, attachments?:AgentAttachment[]) {
  if(runtimes.get(id)==='claude')return promptClaude(id,text,attachments);
  if(runtimes.get(id)==='codex')return promptCodex(id,text,attachments);
  if (!isTauri()) {
    const emit = previews.get(id);
    const turn = (previewTurns.get(id) ?? 0) + 1; previewTurns.set(id, turn);
    emit?.({ kind: 'event', type: 'tool.start', payload: { tool_id: 'preview-read', name: 'read_file', args: { path: 'README.md' } } });
    await new Promise(resolve => setTimeout(resolve, 300));
    if (previews.get(id) !== emit || previewTurns.get(id) !== turn) return;
    emit?.({ kind: 'event', type: 'tool.complete', payload: { tool_id: 'preview-read', name: 'read_file', result_text: 'Демонстрация · Preview', args: { path: 'README.md' } } });
    emit?.({ kind: 'event', type: 'message.complete', payload: { text: document.documentElement.lang === 'ru' ? 'Демонстрация агента. В настольном приложении Hermes выполнит задачу через выбранную модель.' : 'Agent preview. In the desktop app, Hermes runs your task with the selected model.', status: 'complete' } });
    return;
  }
  await invoke('hermes_agent_prompt', { id, text, attachments:attachments?.map(a=>a.path) });
}
export async function inspectAgentFiles(paths:string[]):Promise<AgentAttachment[]> {return invoke('hermes_agent_files',{paths});}
export async function importAgentFile(file:File):Promise<AgentAttachment> {
  if(file.size>25*1024*1024)throw new Error('attachment-limit');
  const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]??'');reader.onerror=()=>reject(new Error('attachment-data'));reader.readAsDataURL(file);});
  return invoke('hermes_agent_import',{name:file.name,data});
}
export async function getAgentContext(id:string):Promise<unknown> {if(hostTaskOf(id))return invoke('hermes_agent_context',{id}).catch(()=>undefined);if(runtimes.get(id)==='claude')return claudeContext(id);if(runtimes.get(id)==='codex')return codexContext(id);if(!isTauri())return undefined;return invoke('hermes_agent_context',{id});}
export async function agentVoice(id:string,action:'start'|'stop'|'cancel'|'status'|'level'):Promise<{status?:string;available?:boolean;details?:string;rms?:number;recording?:boolean}> {if(hostTaskOf(id))return invoke('hermes_agent_voice',{id,action});if(['codex','claude'].includes(runtimes.get(id)??''))throw new Error('voice-not-configured');return invoke('hermes_agent_voice',{id,action});}
export async function setAgentAccess(id:string,mode:AccessMode):Promise<void> {const hostTask=hostTaskOf(id);if(hostTask)return setHostTaskAccess(hostTask,mode);if(runtimes.get(id)==='claude'){await stopClaude(id,true);runtimes.delete(id);throw new Error('new-session-required');}if(runtimes.get(id)==='codex'){codexAccess(id,mode);return;}await invoke('hermes_agent_access',{id,mode});}
export async function stopAgent(id: string, close = false) {
  if(runtimes.get(id)==='claude'){await stopClaude(id,close);if(close)runtimes.delete(id);return;}
  if(runtimes.get(id)==='codex'){await stopCodex(id,close);if(close)runtimes.delete(id);return;}
  if (!isTauri()) { const emit = previews.get(id); previewTurns.set(id, (previewTurns.get(id) ?? 0) + 1); if (close) { previews.delete(id); previewTurns.delete(id); } emit?.(close ? { kind: 'closed' } : { kind: 'event', type: 'message.complete', payload: { status: 'interrupted' } }); return; }
  await invoke('hermes_agent_stop', { id, close });
}
export async function respondAgent(id: string, requestId: string, result: Record<string, unknown>) {
  if(runtimes.get(id)==='claude')return respondClaude(id,requestId,result);
  if(runtimes.get(id)==='codex')return respondCodex(id,requestId,result);
  if (!isTauri()) return;
  await invoke('hermes_agent_respond', { id, requestId, result });
}
