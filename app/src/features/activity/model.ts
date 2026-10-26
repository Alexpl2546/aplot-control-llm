export type ActivityKind='server.state'|'server.issue'|'profile.saved'|'agent.started'|'agent.completed'|'agent.closed'|'agent.tool'|'agent.approval'|'agent.access';
export interface ActivityEvent {id:string;time:number;kind:ActivityKind;level:'info'|'warn'|'error';name:string;runId?:string;taskId?:string;data:Record<string,string|number|boolean>;}
export function isActivityEvent(value:unknown):value is ActivityEvent {
  if(!value||typeof value!=='object')return false;
  const v=value as Record<string,unknown>;
  return typeof v.id==='string'&&typeof v.time==='number'&&Number.isFinite(v.time)&&v.time>0&&v.time<8e15&&typeof v.kind==='string'&&['server.state','server.issue','profile.saved','agent.started','agent.completed','agent.closed','agent.tool','agent.approval','agent.access'].includes(v.kind)&&['info','warn','error'].includes(String(v.level))&&typeof v.name==='string'&&!!v.data&&typeof v.data==='object'&&!Array.isArray(v.data)&&Object.values(v.data).every(x=>['string','number','boolean'].includes(typeof x));
}
export function lifecycleChanged(before:{state:string;generation:number}|undefined,after:{state:string;generation:number}):boolean {
  if(!before)return true;
  if(before.generation!==after.generation)return true;
  if(before.state===after.state)return false;
  // Inference request traffic belongs in telemetry, not the lifecycle timeline.
  return !(['ready','busy'].includes(before.state)&&['ready','busy'].includes(after.state));
}
