import type { AgentFrame } from '../agent/store';
import type { AccessMode } from '../agent/ioModel';
export interface CodexEvent {method:string;params?:Record<string,unknown>;id?:string|number;}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'?v as Record<string,unknown>:{};
export function codexPolicy(mode:AccessMode,cwd:string){
  return {approvalPolicy:mode==='manual'?'on-request':'never',sandbox:mode==='full'?'danger-full-access':mode==='restricted'?'read-only':'workspace-write',
    sandboxPolicy:mode==='full'?{type:'dangerFullAccess'}:mode==='restricted'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
}
export function codexFrames(event:CodexEvent):AgentFrame[]{
  const p=event.params??{},item=object(p.item);
  const emit=(type:string,payload:Record<string,unknown>):AgentFrame[]=>[{kind:'event',type,payload}];
  if(['item/started','item/completed'].includes(event.method)&&item.type==='collabAgentToolCall'){const states=object(item.agentsStates);return (Array.isArray(item.receiverThreadIds)?item.receiverThreadIds:[]).slice(0,32).flatMap(id=>{const child=object(states[String(id)]),status=String(child.status??'running');return emit('agent.update',{id:String(id),name:String(item.tool??'Codex'),activity:String(child.message??item.prompt??'').slice(0,600),status:['completed','failed','stopped'].includes(status)?status:status==='errored'?'failed':'running'});});}
  if(event.method==='item/agentMessage/delta')return emit('message.delta',{text:p.delta});
  if(event.method==='item/reasoning/summaryTextDelta')return emit('reasoning.delta',{text:p.delta});
  if(event.method==='item/commandExecution/outputDelta')return emit('tool.output',{tool_id:p.itemId,text:p.delta});
  if(event.method==='turn/completed'){const turn=object(p.turn);return emit('message.complete',{status:turn.status==='completed'?'complete':turn.status==='interrupted'?'interrupted':'error',...(turn.error?{errorDetail:String(object(turn.error).message??'Codex request failed').slice(0,1000)}:{})});}
  if(event.method==='error')return [{kind:'error',code:'agent-error',payload:{errorDetail:String(object(p.error).message??'Codex request failed').slice(0,1000)}}];
  if(event.method==='thread/tokenUsage/updated'){
    const usage=object(p.tokenUsage),last=object(usage.last);
    return emit('session.usage',{usage:{context_used:Number(last.totalTokens??0),context_max:Number(usage.modelContextWindow??0),context_source:'provider_usage',context_estimated:false}});
  }
  if(['item/started','item/completed'].includes(event.method)&&['commandExecution','fileChange','mcpToolCall','webSearch'].includes(String(item.type))){
    const changes=Array.isArray(item.changes)?item.changes:[];
    return emit(event.method==='item/started'?'tool.start':'tool.complete',{tool_id:item.id,name:item.type==='commandExecution'?'terminal':item.type==='fileChange'?'apply_patch':String(item.tool??item.type),args:item.type==='commandExecution'?{command:item.command,cwd:item.cwd}:{changes,path:object(changes[0]).path},
      result:{status:item.status==='completed'?'completed':item.status==='declined'?'denied':item.status,exit_code:item.exitCode,output:item.aggregatedOutput??item.result??''},inline_diff:changes.map(c=>String(object(c).diff??'')).join('\n')});
  }
  if(event.id!==undefined&&event.method.endsWith('/requestApproval')){
    const decisions=Array.isArray(p.availableDecisions)?p.availableDecisions:undefined;
    const session=!decisions||decisions.includes('acceptForSession');
    const always=!!p.proposedExecpolicyAmendment&&(!decisions||decisions.some(d=>object(d).acceptWithExecpolicyAmendment!==undefined));
    return [{kind:'request',method:'approval',id:JSON.stringify(event.id),params:{description:p.reason??event.method,command:p.command??JSON.stringify(p.changes??{}),choices:['once','deny',...(session?['session']:[]),...(always?['always']:[])],allow_session:session,allow_permanent:always}}];
  }
  if(event.id!==undefined&&event.method==='item/tool/requestUserInput')return [{kind:'request',method:'clarify',id:JSON.stringify(event.id),params:{questions:(Array.isArray(p.questions)?p.questions:[]).map(q=>{const question=object(q);return {qid:question.id,question:question.question,choices:Array.isArray(question.options)?question.options.map(o=>String(object(o).label)):undefined};})}}];
  return [];
}
export function codexApproval(event:CodexEvent,result:Record<string,unknown>){
  if(event.method==='item/tool/requestUserInput')return {answers:Object.fromEntries(Object.entries(object(result.answers)).map(([id,text])=>[id,{answers:[String(text)]}]))};
  const choice=result.choice,p=event.params??{};
  if(choice==='always'){if(!p.proposedExecpolicyAmendment)throw new Error('unsupported-permanent');return {decision:{acceptWithExecpolicyAmendment:{execpolicy_amendment:p.proposedExecpolicyAmendment}}};}
  if(choice==='session')return {decision:'acceptForSession'};
  return {decision:choice==='once'?'accept':'decline'};
}
