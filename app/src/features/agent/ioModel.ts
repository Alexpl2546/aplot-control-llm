export type AccessMode = 'manual' | 'full' | 'restricted';
export interface AgentAttachment { id:string; path:string; name:string; size:number; kind:'image'|'file'; }
export interface ContextCategory { id:string; label:string; tokens:number; }
export interface ContextFile { label:string; path:string; chars:number; est_tokens:number; loaded:boolean; status:string; }
export interface AgentContext {
  context_used:number; context_max:number; context_source:string; context_estimated:boolean;
  estimated_total:number; categories:ContextCategory[]; context_files:ContextFile[]; updatedAt:number;
}
const number = (value:unknown) => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
export function readContext(value:unknown):AgentContext|undefined {
  if(!value||typeof value!=='object')return;
  const data=value as Record<string,unknown>;
  if(!('context_used' in data)&&!('categories' in data))return;
  return {context_used:number(data.context_used),context_max:number(data.context_max),context_source:String(data.context_source??'local_estimate'),context_estimated:data.context_estimated!==false,estimated_total:number(data.estimated_total),
    categories:Array.isArray(data.categories)?data.categories.filter(c=>c&&typeof c.id==='string'&&typeof c.tokens==='number').map(c=>({id:c.id,label:String(c.label??c.id),tokens:number(c.tokens)})):[],
    context_files:Array.isArray(data.context_files)?data.context_files.filter(f=>f&&typeof f.path==='string').map(f=>({label:String(f.label??f.path),path:f.path,chars:number(f.chars),est_tokens:number(f.est_tokens),loaded:f.loaded===true,status:String(f.status??'')})):[],updatedAt:Date.now()};
}
export function contextPercent(context?:AgentContext) {return context&&context.context_max>0?Math.min(100,Math.max(0,context.context_used/context.context_max*100)):undefined;}
export function approvalChoices(params:Record<string,unknown>):string[] {
  const offered=Array.isArray(params.choices)?params.choices:['once','deny'];
  return offered.filter((v):v is string=>typeof v==='string'&&['once','session','always','deny'].includes(v)&&!(v==='always'&&params.allow_permanent===false)&&!(v==='session'&&params.allow_session===false));
}
