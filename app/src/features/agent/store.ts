import { create } from 'zustand';
import { toolOutcome, type ToolOutcome, type MemorySnapshot } from './workspaceModel';
import { readContext, type AgentAttachment, type AgentContext, type AccessMode } from './ioModel';

export interface AgentEntry { id: string; kind: 'user' | 'assistant' | 'tool' | 'notice'; text: string; reasoning?: string; name?: string; status?: ToolOutcome; details?: string; args?: unknown; result?: unknown; diff?: string; duration?: number; time?: number; attachments?:AgentAttachment[]; }
export interface AgentQuestion { id: string; method: 'approval' | 'clarify'; params: Record<string, unknown>; }
export interface AgentChild {id:string;name:string;activity:string;status:string;}
export interface QueuedPrompt {id:string;text:string;attachments?:AgentAttachment[];time:number;}
export interface AgentThread {children?:AgentChild[];queue?:QueuedPrompt[]; id?: string; entries: AgentEntry[]; requests: AgentQuestion[]; draft: string; cwd: string; skills: string; pending: boolean; starting: boolean; ended: boolean; error: string; stopped: boolean; cursor?: string; restored?: boolean; hermesSessionId?: string; nativeSessionId?:string; nativeRuntime?:'codex'|'claude'; nativeConnectionId?:string; actualModelId?: string; actualContextTokens?: number; appliedMemory?: MemorySnapshot[]; attachments?:AgentAttachment[]; context?:AgentContext; voiceStatus?:string; voiceStartedAt?:number; voiceDiscard?:boolean; voiceSendAfter?:boolean; ioError?:string; accessMode?:AccessMode; }
export const EMPTY_AGENT: AgentThread = { entries: [], requests: [], draft: '', cwd: '', skills: '', pending: false, starting: false, ended: false, error: '', stopped: false };
export const useAgentStore = create<{
  mode: 'chat' | 'agent'; setMode: (mode: 'chat' | 'agent') => void;
  threads: Record<string, AgentThread>; update: (key: string, edit: (thread: AgentThread) => AgentThread) => void;
}>((set) => ({ mode: 'chat', setMode: mode => set({ mode }), threads: {}, update: (key, edit) => set(state => ({ threads: { ...state.threads, [key]: edit(state.threads[key] ?? EMPTY_AGENT) } })) }));

export type AgentFrame = { kind: 'event' | 'request' | 'error' | 'closed'; type?: string; payload?: Record<string, unknown>; id?: string; method?: string; params?: Record<string, unknown>; code?: string };
function text(value: unknown) { return typeof value === 'string' ? value : ''; }
function display(value: unknown) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
export function agentFrame(thread: AgentThread, frame: AgentFrame): AgentThread {
  if (frame.kind === 'closed') return { ...thread, id: undefined, starting: false, pending: false, ended: true, requests: [], voiceStatus:'idle', cursor: undefined, entries: thread.entries.map(e => e.status === 'running' ? { ...e, status: 'unknown' } : e), error: thread.error || 'closed' };
  if (frame.kind === 'error') return { ...thread, starting: false, pending: false, requests: [], error: frame.code ?? 'agent-error', ioError:typeof frame.payload?.errorDetail==='string'?frame.payload.errorDetail:thread.ioError,cursor: undefined };
  if (frame.kind === 'request' && frame.id && (frame.method === 'approval' || frame.method === 'clarify')) return { ...thread, requests: [...thread.requests.filter(r => r.id !== frame.id), { id: frame.id, method: frame.method, params: frame.params ?? {} }] };
  const payload = frame.payload ?? {}, type = frame.type;
  if(type==='agent.update'&&typeof payload.id==='string'){const child={id:payload.id,name:String(payload.name??'Agent').slice(0,120),activity:String(payload.activity??'').slice(0,600),status:String(payload.status??'unknown')};return {...thread,children:[...(thread.children??[]).filter(c=>c.id!==child.id),child].slice(-32)};}
  if(type==='voice.status'){const state=text(payload.state)||'idle';if(thread.voiceDiscard&&state!=='idle')return thread;return {...thread,voiceStatus:state,voiceSendAfter:state==='idle'?false:thread.voiceSendAfter,voiceStartedAt:state==='idle'?undefined:thread.voiceStartedAt,ioError:state==='idle'&&thread.voiceStatus==='transcribing'&&!thread.voiceDiscard?'no-speech':thread.ioError};}
  if(type==='voice.transcript'){if(thread.voiceDiscard)return thread;return {...thread,voiceStatus:'idle',voiceStartedAt:undefined,voiceSendAfter:false,draft:payload.stop_phrase?thread.draft:[thread.draft,text(payload.text)].filter(Boolean).join('\n'),ioError:payload.no_speech_limit||!text(payload.text).trim()?'no-speech':undefined};}
  if(type==='session.usage') {
    const usage=readContext(payload.usage);
    return usage?{...thread,context:{...usage,categories:thread.context?.categories??[],context_files:thread.context?.context_files??[],estimated_total:thread.context?.estimated_total??0}}:thread;
  }
  if (type === 'session.created') return { ...thread, ...(payload.runtime==='codex'||payload.runtime==='claude'?{nativeSessionId:text(payload.sessionId),nativeRuntime:payload.runtime,nativeConnectionId:text(payload.connectionId),restored:false}:{}), hermesSessionId: text(payload.sessionId) || undefined, actualModelId:text(payload.modelId) || undefined, actualContextTokens:typeof payload.contextTokens === 'number' ? payload.contextTokens : undefined };
  if (type === 'request.cancel') return { ...thread, requests: thread.requests.filter(r => r.id !== payload.id) };
  if (type === 'tool.output') return {...thread,entries:thread.entries.map(e=>e.kind==='tool'&&e.id===text(payload.tool_id)?{...e,text:(e.text+text(payload.text)).slice(-60000)}:e)};
  if (type === 'error') return { ...thread, pending: false, starting: false, requests: [], cursor: undefined, error: 'agent-error' };
  if (type === 'tool.start' || type === 'tool.complete') {
    const id = text(payload.tool_id); if (!id) return thread;
    const existing = thread.entries.find(e => e.kind === 'tool' && e.id === id);
    const entry: AgentEntry = { id, kind: 'tool', name: text(payload.name) || existing?.name, text: display(payload.result ?? payload.result_text ?? payload.summary ?? payload.preview).slice(0, 60000), details: payload.args ? display(payload.args).slice(0, 60000) : existing?.details, args: payload.args ?? existing?.args, result: payload.result, diff: text(payload.inline_diff) || existing?.diff, duration: typeof payload.duration_s === 'number' ? payload.duration_s : undefined, time: existing?.time ?? Date.now(), status: type === 'tool.start' ? 'running' : toolOutcome(payload.result ?? payload.result_text) };
    return { ...thread, cursor: undefined, entries: existing ? thread.entries.map(e => e === existing ? { ...existing, ...entry } : e) : [...thread.entries, entry] };
  }
  if (type === 'message.interim') return { ...thread, cursor: undefined, entries: payload.already_streamed || !text(payload.text) ? thread.entries : [...thread.entries, { id: crypto.randomUUID(), kind: 'assistant', text: text(payload.text) }] };
  if (['message.delta', 'reasoning.delta', 'thinking.delta', 'reasoning.available', 'message.complete'].includes(type ?? '')) {
    const entries = [...thread.entries];
    let entry = entries.find(e => e.id === thread.cursor && e.kind === 'assistant');
    const final = type === 'message.complete';
    const chunk = text(payload.text);
    if (!entry && (chunk || payload.reasoning)) { entry = { id: crypto.randomUUID(), kind: 'assistant', text: '' }; entries.push(entry); }
    if (entry) {
      const reasoning = type?.startsWith('reasoning.') || type === 'thinking.delta';
      entries[entries.indexOf(entry)] = { ...entry, time: entry.time ?? Date.now(), text: reasoning ? entry.text : final ? chunk || entry.text : entry.text + chunk, reasoning: final ? text(payload.reasoning) || entry.reasoning : reasoning ? (type === 'reasoning.available' ? chunk : (entry.reasoning ?? '') + chunk) : entry.reasoning };
    }
    const usage=final?readContext(payload.usage):undefined;
    if(final&&typeof payload.errorDetail==='string')thread={...thread,ioError:payload.errorDetail};
    return { ...thread, ...(usage?{context:{...usage,categories:thread.context?.categories??[],context_files:thread.context?.context_files??[],estimated_total:thread.context?.estimated_total??0}}:{}), entries: final ? entries.map(e => e.status === 'running' ? { ...e, status: payload.status === 'interrupted' ? 'interrupted' : 'unknown' } : e) : entries, cursor: final ? undefined : entry?.id, pending: final ? false : thread.pending, requests: final ? [] : thread.requests, stopped: final && payload.status === 'interrupted', error: final && (payload.status === 'error' || payload.partial === true) ? 'agent-error' : thread.error };
  }
  return thread;
}
