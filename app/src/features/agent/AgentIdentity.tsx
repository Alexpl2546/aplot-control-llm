import { Asterisk, Bot, Server } from 'lucide-react';

export type AgentRuntime='hermes'|'codex'|'claude';
export const agentName=(runtime?:string)=>runtime==='codex'?'Codex':runtime==='claude'?'Claude':'Hermes';
export function AgentIcon({runtime,size=16}:{runtime?:string;size?:number}){
  return <span className={`agentIdentityIcon is-${runtime??'hermes'}`} aria-hidden="true" style={{width:size,height:size}}>{runtime==='codex'?<span className="agentOpenAiMark"/>:runtime==='claude'?<Asterisk size={size}/>:runtime==='local'?<Server size={size}/>:<Bot size={size}/>}</span>;
}
export const agentOptions=()=>[...(['hermes','codex','claude'] as const)].map(value=>({value,label:agentName(value),icon:<AgentIcon runtime={value}/>}));
