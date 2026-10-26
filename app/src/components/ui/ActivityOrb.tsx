import { ThinkingOrb,type OrbState } from 'thinking-orbs';
import type { AgentThread } from '../../features/agent/store';

export function activityState(thread:AgentThread):OrbState{
  if(thread.starting)return 'connecting';
  const last=thread.entries.at(-1);
  if(last?.kind==='tool'&&last.status==='running')return /search|read|glob|grep|list|browse/i.test(last.name??'')?'searching':'working';
  if(last?.kind==='assistant'&&last.text)return 'composing';
  return 'working';
}
export function ActivityOrb({state='working',size=20}:{state?:OrbState;size?:20|32|64}){
  return <span className="activityOrb" aria-hidden="true"><ThinkingOrb state={state} size={size} speed={.85} color="#c8ef7d" aria-hidden="true"/></span>;
}
