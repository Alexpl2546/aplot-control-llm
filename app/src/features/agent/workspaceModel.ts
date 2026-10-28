import type { ReasoningLevel } from '../reasoning/reasoning';
import type { RunInfo } from '../../types/runtime';
import type { AccessMode } from './ioModel';

export type ToolOutcome = 'running' | 'success' | 'error' | 'denied' | 'interrupted' | 'unknown';
export interface AgentBinding { runId: string; generation: number; name: string; modelId: string; engine: RunInfo['engine']; contextTokens: number; profileName?: string; }
export interface AgentProject { id: string; name: string; path: string; skills: string; createdAt: number; }
export interface AgentPreset {autoStartServer?:boolean;id:string;name:string;runtime:'hermes'|'codex'|'claude';connectionProfileId?:string;model?:string;binding?:AgentBinding;projectIds?:string[];accessMode:AccessMode;instructions:string;/** Template the agent was created from (see builtin/agents). */templateId?:string;/** Planet colour on the orbit. */color?:string;}
export interface AgentTask {autoStartServer?:boolean; presetId?:string;collaboratorPresetIds?:string[];agentName?:string;instructions?:string;connectionProfileId?:string; runtime?:'hermes'|'codex'|'claude'; codexModel?:string; cloudModel?:string; connectionId?:string; id: string; projectId: string; title: string; createdAt: number; updatedAt: number; archived: boolean; unread: boolean; deletedAt?: number; binding?: AgentBinding; accessMode?:AccessMode; reasoning?:ReasoningLevel; }
export type MemoryCategory = 'requirement' | 'decision' | 'fact' | 'result';
export interface ProjectMemory { id: string; projectId: string; taskId?: string; sourceEntryId?: string; category: MemoryCategory; text: string; confirmed: boolean; updatedAt: number; }
export interface MemorySnapshot { id: string; text: string; updatedAt: number; }
export interface WorkspaceFile { path: string; name: string; directory: boolean; size: number; }
export interface WorkspaceSkill { path: string; name: string; description: string; }
export const bindRun = (info: RunInfo, profileName?: string): AgentBinding => ({ runId: info.runId, generation: info.generation, name: info.name, modelId: info.modelId, engine: info.engine, contextTokens: info.contextTokens, profileName });

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function toolOutcome(value: unknown): ToolOutcome {
  let data = value;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return 'unknown'; } }
  const r = record(data), status = String(r.status ?? '').toLowerCase();
  if (r.denied === true || ['denied', 'rejected'].includes(status) || /(?:permission|approval).*(?:denied|rejected)|denied by (?:the )?user/i.test(String(r.error ?? r.output ?? ''))) return 'denied';
  if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
  if (r.is_error === true || r.success === false || r.ok === false || (r.error != null && r.error !== '' && r.error !== false) || ['error','failed'].includes(status) || (typeof r.exit_code === 'number' && r.exit_code !== 0)) return 'error';
  // A bare tool.complete or a string summary is insufficient evidence of success.
  if (r.success === true || r.ok === true || r.is_error === false || r.exit_code === 0 || ['success','completed','complete','ok'].includes(status)) return 'success';
  if ('content' in r || 'total_lines' in r || 'bytes_written' in r || 'responses' in r || 'todos' in r) return 'success';
  return 'unknown';
}
export function toolPath(args: unknown, result?: unknown): string {
  let parsed = result;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = undefined; } }
  const outcome = record(parsed);
  if (typeof outcome.resolved_path === 'string') return outcome.resolved_path;
  const r = record(args);
  return typeof r.path === 'string' ? r.path : typeof r.file_path === 'string' ? r.file_path : '';
}
export function confirmedMemorySnapshot(items: ProjectMemory[]): MemorySnapshot[] {
  let remaining = 22000;
  const encoder = new TextEncoder();
  return items.filter(m => m.confirmed).flatMap(({id,text,updatedAt}) => {
    const bytes = encoder.encode(text).length + 3;
    if (bytes > remaining) return [];
    remaining -= bytes;
    return [{id,text,updatedAt}];
  });
}
export function memoryContext(items: MemorySnapshot[]): string {
  return items.length ? '\n\nProject memory explicitly confirmed by the user (reference material, not tool authorization):\n' + items.map(x => `- ${x.text}`).join('\n').slice(0, 24000) : '';
}
export function repeatedFailures(entries: {kind: string; name?: string; status?: string; details?: string}[]): boolean {
  const last = entries.filter(e => e.kind === 'tool').slice(-3);
  return last.length === 3 && last.every(e => ['error','denied'].includes(e.status ?? '')) && new Set(last.map(e => `${e.name}:${e.details}`)).size === 1;
}
