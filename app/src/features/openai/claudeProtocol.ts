import type { AgentFrame } from '../agent/store';
export const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export interface ClaudeStreamState {streamed:boolean;lastInput?:number;output:number;contextWindow?:number;}
export function claudeFrames(packet:Record<string,unknown>,state:ClaudeStreamState):AgentFrame[]{
  const event=object(packet.event),delta=object(event.delta),message=object(packet.message);
  const emit=(type:string,payload:Record<string,unknown>):AgentFrame[]=>[{kind:'event',type,payload}];
  if(packet.parent_tool_use_id&&['assistant','user','stream_event'].includes(String(packet.type)))return [];
  if(packet.type==='system'&&['task_started','task_progress','task_notification'].includes(String(packet.subtype))&&packet.task_id)return emit('agent.update',{id:packet.task_id,name:packet.description??'Claude',activity:packet.summary??packet.last_tool_name??packet.description??'',status:packet.subtype==='task_notification'?packet.status==='completed'?'completed':packet.status==='failed'?'failed':'stopped':'running'});
  if(packet.type==='aplot_closed')return [{kind:'closed'}];
  if(packet.type==='control_cancel_request')return emit('request.cancel',{id:packet.request_id});
  if(packet.type==='system'&&packet.subtype==='init')return emit('session.created',{sessionId:packet.session_id,modelId:packet.model});
  if(packet.type==='stream_event'){
    if(event.type==='message_start'){const usage=object(object(event.message).usage);if(typeof usage.input_tokens==='number'){state.lastInput=usage.input_tokens+Number(usage.cache_read_input_tokens??0)+Number(usage.cache_creation_input_tokens??0);state.output=0;}}
    if(event.type==='message_delta'){const usage=object(event.usage);if(typeof usage.output_tokens==='number')state.output=usage.output_tokens;}
    if(delta.type==='text_delta'){state.streamed=true;return emit('message.delta',{text:delta.text});}
    if(delta.type==='thinking_delta')return emit('reasoning.delta',{text:delta.thinking});
  }
  if(packet.type==='assistant'&&!packet.parent_tool_use_id){
    const frames:AgentFrame[]=[];
    for(const block of Array.isArray(message.content)?message.content:[]){const b=object(block);
      if(b.type==='tool_use')frames.push(...emit('tool.start',{tool_id:b.id,name:({Read:'read_file',Write:'write_file',Edit:'edit_file',Bash:'terminal',Glob:'list_directory',Grep:'search_files'} as Record<string,string>)[String(b.name)]??b.name,args:b.input}));
      if(b.type==='text'&&!state.streamed)frames.push(...emit('message.delta',{text:b.text}));
    }state.streamed=false;return frames;
  }
  if(packet.type==='user'&&!packet.parent_tool_use_id){return (Array.isArray(message.content)?message.content:[]).flatMap(v=>{const b=object(v);return b.type==='tool_result'?emit('tool.complete',{tool_id:b.tool_use_id,result:{is_error:b.is_error===true,output:typeof b.content==='string'?b.content:JSON.stringify(b.content)}}):[];});}
  if(packet.type==='control_request'){
    const r=object(packet.request);if(r.subtype!=='can_use_tool')return [];
    const input=object(r.input),questions=Array.isArray(input.questions)?input.questions:[];
    if(r.tool_name==='AskUserQuestion')return [{kind:'request',id:String(packet.request_id),method:'clarify',params:{questions:questions.map((v,index)=>{const q=object(v);return {qid:String(index),question:q.question,choices:Array.isArray(q.options)?q.options.map(v=>String(object(v).label)):[]};})}}];
    const suggestions=Array.isArray(r.permission_suggestions)?r.permission_suggestions:[];
    const canPersist=suggestions.some(v=>object(v).type==='addRules'&&Array.isArray(object(v).rules));
    return [{kind:'request',id:String(packet.request_id),method:'approval',params:{description:r.tool_name,command:JSON.stringify(r.input,null,2),choices:['once','deny',...(canPersist?['session','always']:[])],allow_session:canPersist,allow_permanent:canPersist}}];
  }
  if(packet.type==='result'){
    const usage=object(packet.modelUsage);for(const value of Object.values(usage)){const model=object(value);if(typeof model.contextWindow==='number')state.contextWindow=model.contextWindow;}
    return emit('message.complete',{status:packet.is_error?'error':'complete',...(packet.is_error?{errorDetail:JSON.stringify(packet.errors??packet.result??'Claude request failed').slice(0,2000)}:{}),...(state.lastInput===undefined?{}:{usage:{context_used:state.lastInput+state.output,context_max:state.contextWindow??0,context_source:'provider_usage',context_estimated:false}})});
  }
  return [];
}
export function claudeApproval(packet:Record<string,unknown>,result:Record<string,unknown>){
  const request=object(packet.request),input=object(request.input);
  if(request.tool_name==='AskUserQuestion'){
    const answers=object(result.answers);if(!Object.keys(answers).length)return {behavior:'deny',message:'The user skipped this question.'};return {behavior:'allow',updatedInput:{...input,answers:Object.fromEntries((Array.isArray(input.questions)?input.questions:[]).map((v,index)=>[String(object(v).question),String(answers[index]??'')]))}};
  }
  if(result.choice==='deny')return {behavior:'deny',message:'The user declined this action.'};
  const updates=Array.isArray(request.permission_suggestions)?request.permission_suggestions.filter(v=>object(v).type==='addRules'&&Array.isArray(object(v).rules)):[];
  if(['always','session'].includes(String(result.choice))&&!updates.length)throw new Error('unsupported-permanent');
  return {behavior:'allow',updatedInput:input,...(['always','session'].includes(String(result.choice))?{updatedPermissions:updates.map(v=>({...object(v),destination:result.choice==='always'?'userSettings':'session'}))}:{})};
}
